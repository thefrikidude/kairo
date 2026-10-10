import { createHash } from "node:crypto";
import type { TaskWorkspace } from "../../domain/task-workspace.js";
import Database from "better-sqlite3";
import type { SessionRuntime } from "../../domain/agent-runtime.js";
import { databasePath, ensureStateDir } from "../filesystem/platform-paths.js";
import type {
  ContextCheckpoint,
  Message,
  TaskEvent,
  RepairAttempt,
  RepositorySnapshot,
  Task,
  TaskStatus,
  TaskMode,
  TaskPlan,
  VerificationSelection,
  EvaluationAttempt,
  EvaluationRun,
  WorkspaceEditPermission,
} from "../../domain/models.js";

export interface Session {
  id: string;
  workspace: string;
  workspaceId: string;
  title: string;
  lastTaskStatus?: TaskStatus;
  createdAt: number;
  updatedAt: number;
  permissionMode: WorkspaceEditPermission;
  archivedAt?: number;
  runtime: SessionRuntime;
  externalSessionId?: string;
}

function sessionTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "New session";
  return value.trim().replace(/\s+/g, " ");
}

export class SqliteSessionStore {
  /** Wraps an already-initialized database; callers use open() to guarantee setup. */
  private constructor(private readonly db: Database.Database) {}
  /** Opens the database, creates current schema objects, and recovers interrupted tasks. */
  static async open(path?: string): Promise<SqliteSessionStore> {
    if (!path) await ensureStateDir();
    const db = new Database(path || databasePath());
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, permission_mode TEXT NOT NULL DEFAULT 'workspace', archived_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, created_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS tool_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT NOT NULL, approved INTEGER, output TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'implementation', status TEXT NOT NULL, plan_json TEXT, changed_files_json TEXT NOT NULL DEFAULT '[]', approved_write_paths_json TEXT NOT NULL DEFAULT '[]', verification_command TEXT, verification_output TEXT, verification_ok INTEGER, verification_exit_code INTEGER, verification_discovered INTEGER, verification_selection_json TEXT, summary TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE INDEX IF NOT EXISTS tasks_session_updated ON tasks(session_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS context_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, summary TEXT NOT NULL, through_message_id INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE INDEX IF NOT EXISTS checkpoints_session_created ON context_checkpoints(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS repository_profiles (session_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));`);
    const sessionColumns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as {
      name: string;
    }[];
    if (!sessionColumns.some((column) => column.name === "permission_mode"))
      db.exec("ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace'");
    if (!sessionColumns.some((column) => column.name === "archived_at"))
      db.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
    if (!sessionColumns.some((column) => column.name === "runtime_json"))
      db.exec("ALTER TABLE sessions ADD COLUMN runtime_json TEXT");
    if (!sessionColumns.some((column) => column.name === "external_session_id"))
      db.exec("ALTER TABLE sessions ADD COLUMN external_session_id TEXT");
    if (!sessionColumns.some((column) => column.name === "title"))
      db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
    if (!sessionColumns.some((column) => column.name === "workspace_id"))
      db.exec("ALTER TABLE sessions ADD COLUMN workspace_id TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS task_workspaces (
      id TEXT PRIMARY KEY, repository_path TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, branch TEXT, base_commit TEXT, managed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, removed_at INTEGER
    ); CREATE INDEX IF NOT EXISTS sessions_workspace_id ON sessions(workspace_id);`);
    const legacyWorkspaces = db
      .prepare("SELECT DISTINCT workspace FROM sessions WHERE workspace_id IS NULL")
      .all() as { workspace: string }[];
    db.transaction(() => {
      for (const { workspace } of legacyWorkspaces) {
        const id = `ws-${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}`;
        db.prepare(
          "INSERT OR IGNORE INTO task_workspaces(id, repository_path, directory, kind, managed, created_at) VALUES (?, ?, ?, 'folder', 0, ?)",
        ).run(id, workspace, workspace, Date.now());
        const row = db
          .prepare("SELECT id FROM task_workspaces WHERE directory=?")
          .get(workspace) as { id: string };
        db.prepare(
          "UPDATE sessions SET workspace_id=? WHERE workspace=? AND workspace_id IS NULL",
        ).run(row.id, workspace);
      }
    })();
    const messageColumns = db.prepare("SELECT name FROM pragma_table_info('messages')").all() as {
      name: string;
    }[];
    if (!messageColumns.some((column) => column.name === "agent_name"))
      db.exec("ALTER TABLE messages ADD COLUMN agent_name TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS repair_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, command TEXT NOT NULL, evidence_json TEXT NOT NULL, selected_files_json TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id));
      CREATE INDEX IF NOT EXISTS repair_attempts_task_created ON repair_attempts(task_id, created_at DESC);`);
    const columns = db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "verification_ok"))
      db.exec("ALTER TABLE tasks ADD COLUMN verification_ok INTEGER");
    if (!columns.some((column) => column.name === "verification_exit_code"))
      db.exec("ALTER TABLE tasks ADD COLUMN verification_exit_code INTEGER");
    if (!columns.some((column) => column.name === "verification_discovered"))
      db.exec("ALTER TABLE tasks ADD COLUMN verification_discovered INTEGER");
    if (!columns.some((column) => column.name === "verification_selection_json"))
      db.exec("ALTER TABLE tasks ADD COLUMN verification_selection_json TEXT");
    if (!columns.some((column) => column.name === "mode"))
      db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'implementation'");
    if (!columns.some((column) => column.name === "plan_json"))
      db.exec("ALTER TABLE tasks ADD COLUMN plan_json TEXT");
    if (!columns.some((column) => column.name === "approved_write_paths_json"))
      db.exec("ALTER TABLE tasks ADD COLUMN approved_write_paths_json TEXT NOT NULL DEFAULT '[]'");
    const store = new SqliteSessionStore(db);
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id)",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS evaluation_runs (
        id TEXT PRIMARY KEY,
        suite TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'gemini',
        model TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        trial_count INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        passed_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS evaluation_runs_started ON evaluation_runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS evaluation_attempts (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        trial INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        task_status TEXT NOT NULL,
        verified INTEGER NOT NULL,
        expectation_passed INTEGER NOT NULL,
        failure_category TEXT,
        metrics_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES evaluation_runs(id)
      );
      CREATE INDEX IF NOT EXISTS evaluation_attempts_run ON evaluation_attempts(run_id, id);`);
    const evaluationColumns = db
      .prepare("SELECT name FROM pragma_table_info('evaluation_runs')")
      .all() as { name: string }[];
    if (!evaluationColumns.some((column) => column.name === "provider"))
      db.exec("ALTER TABLE evaluation_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini'");
    db.exec(
      "CREATE TABLE IF NOT EXISTS evaluation_baselines (suite TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES evaluation_runs(id))",
    );
    store.recoverInterruptedTasks();
    return store;
  }
  /** Closes the SQLite handle during desktop runtime shutdown. */
  close(): void {
    this.db.close();
  }
  /** Atomically replaces the local self baseline after validating the selected run. */
  setEvaluationBaseline(runId: string): EvaluationRun {
    const run = this.evaluationRun(runId);
    if (!run) throw new Error(`Evaluation run not found: ${runId}`);
    if (run.suite !== "self" || run.completedAt === undefined || run.trialCount < 3)
      throw new Error(
        "Baseline must be a completed self-evaluation run with at least three trials.",
      );
    this.db
      .prepare(
        "INSERT INTO evaluation_baselines(suite, run_id) VALUES ('self', ?) ON CONFLICT(suite) DO UPDATE SET run_id=excluded.run_id",
      )
      .run(runId);
    return run;
  }
  /** Resolves the baseline pointer without duplicating evaluation metadata. */
  evaluationBaseline(): EvaluationRun | undefined {
    const row = this.db
      .prepare("SELECT run_id FROM evaluation_baselines WHERE suite='self'")
      .get() as { run_id: string } | undefined;
    return row ? this.evaluationRun(row.run_id) : undefined;
  }
  /** Starts a metadata-only real-model evaluation run. */
  createEvaluationRun(
    input: Omit<EvaluationRun, "id" | "attemptCount" | "passedCount">,
  ): EvaluationRun {
    const run: EvaluationRun = {
      ...input,
      id: `eval-${input.startedAt.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
      attemptCount: 0,
      passedCount: 0,
    };
    this.db
      .prepare(
        "INSERT INTO evaluation_runs(id, suite, provider, model, source_revision, trial_count, attempt_count, passed_count, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.suite,
        run.provider,
        run.model,
        run.sourceRevision,
        run.trialCount,
        0,
        0,
        run.startedAt,
        null,
      );
    return run;
  }
  /** Saves counters and a sanitized outcome without raw prompts, source, or tool output. */
  saveEvaluationAttempt(attempt: EvaluationAttempt): void {
    this.db
      .prepare(
        "INSERT INTO evaluation_attempts(run_id, scenario_id, trial, passed, task_status, verified, expectation_passed, failure_category, metrics_json, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        attempt.runId,
        attempt.scenarioId,
        attempt.trial,
        Number(attempt.passed),
        attempt.taskStatus,
        Number(attempt.verified),
        Number(attempt.expectationPassed),
        attempt.failureCategory ?? null,
        JSON.stringify(attempt.metrics),
        attempt.durationMs,
        attempt.createdAt,
      );
  }
  /** Computes aggregate counts from attempts so historical reports cannot drift. */
  completeEvaluationRun(id: string): EvaluationRun {
    const aggregate = this.db
      .prepare(
        "SELECT count(*) AS attempts, coalesce(sum(passed), 0) AS passed FROM evaluation_attempts WHERE run_id=?",
      )
      .get(id) as { attempts: number; passed: number };
    this.db
      .prepare(
        "UPDATE evaluation_runs SET attempt_count=?, passed_count=?, completed_at=? WHERE id=?",
      )
      .run(aggregate.attempts, aggregate.passed, Date.now(), id);
    const run = this.evaluationRun(id);
    if (!run) throw new Error(`Evaluation run not found: ${id}`);
    return run;
  }
  /** Lists recent evaluation runs, newest first. */
  evaluationRuns(limit = 20): EvaluationRun[] {
    return (
      this.db
        .prepare("SELECT * FROM evaluation_runs ORDER BY started_at DESC LIMIT ?")
        .all(limit) as Record<string, unknown>[]
    ).map((row) => this.toEvaluationRun(row));
  }
  /** Reads one saved evaluation run. */
  evaluationRun(id: string): EvaluationRun | undefined {
    const row = this.db.prepare("SELECT * FROM evaluation_runs WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.toEvaluationRun(row) : undefined;
  }
  /** Reads attempts in stable execution order. */
  evaluationAttempts(runId: string): EvaluationAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM evaluation_attempts WHERE run_id=? ORDER BY id")
        .all(runId) as Record<string, unknown>[]
    ).map((row) => ({
      runId: String(row.run_id),
      scenarioId: String(row.scenario_id),
      trial: Number(row.trial),
      passed: Boolean(row.passed),
      taskStatus: row.task_status as TaskStatus,
      verified: Boolean(row.verified),
      expectationPassed: Boolean(row.expectation_passed),
      failureCategory: row.failure_category as EvaluationAttempt["failureCategory"],
      metrics: JSON.parse(String(row.metrics_json)) as EvaluationAttempt["metrics"],
      durationMs: Number(row.duration_ms),
      createdAt: Number(row.created_at),
    }));
  }
  /** Stores bounded operation metadata separately from model context and raw tool history. */
  recordTaskEvent(event: TaskEvent): void {
    this.db
      .prepare("INSERT INTO task_events(task_id, event_json) VALUES (?, ?)")
      .run(event.taskId, JSON.stringify(event));
  }
  /** Uses insertion ids rather than timestamps to preserve ordering within the same millisecond. */
  taskEvents(taskId: string): TaskEvent[] {
    return (
      this.db
        .prepare("SELECT id, event_json FROM task_events WHERE task_id=? ORDER BY id")
        .all(taskId) as { id: number; event_json: string }[]
    ).map((row) => ({ ...(JSON.parse(row.event_json) as TaskEvent), id: row.id }));
  }
  /** Creates a durable session associated with one resolved workspace. */
  /** Catalog records survive chat deletion; removing a conversation never deletes files. */
  registerWorkspace(input: Omit<TaskWorkspace, "id" | "createdAt" | "removedAt">): TaskWorkspace {
    const previous = this.workspaces(true).find((item) => item.directory === input.directory);
    if (previous?.removedAt) throw new Error("This workspace was removed. Choose another folder.");
    const workspace: TaskWorkspace = {
      ...input,
      id: previous?.id ?? `ws-${crypto.randomUUID()}`,
      createdAt: previous?.createdAt ?? Date.now(),
      managed: previous?.managed || input.managed,
      baseCommit: previous?.baseCommit ?? input.baseCommit,
    };
    this.db
      .prepare(
        `INSERT INTO task_workspaces(id, repository_path, directory, kind, branch, base_commit, managed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(directory) DO UPDATE SET repository_path=excluded.repository_path, kind=excluded.kind, branch=excluded.branch, base_commit=excluded.base_commit, managed=excluded.managed`,
      )
      .run(
        workspace.id,
        workspace.repositoryPath,
        workspace.directory,
        workspace.kind,
        workspace.branch ?? null,
        workspace.baseCommit ?? null,
        workspace.managed ? 1 : 0,
        workspace.createdAt,
      );
    return workspace;
  }
  /** Canonicalize legacy aliases without changing physical ownership or native session identity. */
  reconcileWorkspace(
    id: string,
    input: Omit<TaskWorkspace, "id" | "createdAt" | "removedAt">,
  ): TaskWorkspace {
    return this.db.transaction(() => {
      const previous = this.workspace(id);
      if (!previous || previous.removedAt) throw new Error("Workspace not found.");
      const target = this.workspaces().find((item) => item.directory === input.directory);
      if (target && target.id !== id) {
        this.db
          .prepare("UPDATE sessions SET workspace_id=?, workspace=? WHERE workspace_id=?")
          .run(target.id, target.directory, id);
        this.db.prepare("DELETE FROM task_workspaces WHERE id=?").run(id);
      } else {
        this.db
          .prepare("UPDATE task_workspaces SET directory=? WHERE id=?")
          .run(input.directory, id);
        this.db
          .prepare("UPDATE sessions SET workspace=? WHERE workspace_id=?")
          .run(input.directory, id);
      }
      return this.registerWorkspace({
        ...input,
        managed: previous.managed || input.managed,
        baseCommit: previous.baseCommit ?? input.baseCommit,
      });
    })();
  }
  workspace(id: string): TaskWorkspace | undefined {
    return this.workspaces(true).find((workspace) => workspace.id === id);
  }
  workspaces(includeRemoved = false): TaskWorkspace[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_workspaces ${includeRemoved ? "" : "WHERE removed_at IS NULL"} ORDER BY created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      repositoryPath: String(row.repository_path),
      directory: String(row.directory),
      kind: row.kind as TaskWorkspace["kind"],
      branch: row.branch == null ? undefined : String(row.branch),
      baseCommit: row.base_commit == null ? undefined : String(row.base_commit),
      managed: Boolean(row.managed),
      createdAt: Number(row.created_at),
      removedAt: row.removed_at == null ? undefined : Number(row.removed_at),
    }));
  }
  markWorkspaceRemoved(id: string): void {
    const result = this.db
      .prepare("UPDATE task_workspaces SET removed_at=? WHERE id=? AND removed_at IS NULL")
      .run(Date.now(), id);
    if (result.changes !== 1) throw new Error("Workspace not found.");
  }
  create(workspace: string, runtime: SessionRuntime = { kind: "builtin" }): Session {
    const ownedWorkspace =
      this.workspaces().find((item) => item.directory === workspace) ??
      this.registerWorkspace({
        repositoryPath: workspace,
        directory: workspace,
        kind: "folder",
        managed: false,
      });
    const now = Date.now();
    const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO sessions (id, workspace, workspace_id, created_at, updated_at, runtime_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, ownedWorkspace.directory, ownedWorkspace.id, now, now, JSON.stringify(runtime));
    return {
      id,
      workspace: ownedWorkspace.directory,
      workspaceId: ownedWorkspace.id,
      title: "New session",
      createdAt: now,
      updatedAt: now,
      permissionMode: "workspace",
      runtime,
    };
  }
  /** A custom title survives future turns, archives and restarts. */
  rename(id: string, value: unknown): void {
    if (typeof value !== "string" || !value.trim()) throw new Error("Enter a session name.");
    const title = value.trim().replace(/\s+/g, " ");
    if (title.length > 120) throw new Error("Session names can contain up to 120 characters.");
    const result = this.db
      .prepare("UPDATE sessions SET title=?, updated_at=? WHERE id=?")
      .run(title, Date.now(), id);
    if (result.changes !== 1) throw new Error("Session not found.");
  }
  /** Persists a session runtime/model without discarding its conversation identity. */
  setSessionRuntime(id: string, runtime: SessionRuntime): void {
    const result = this.db
      .prepare("UPDATE sessions SET runtime_json=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(runtime), Date.now(), id);
    if (result.changes !== 1) throw new Error("Session not found.");
  }
  /** Commit the runtime, checkpoint, native-session reset and visible handoff together. */
  switchSessionRuntime(
    id: string,
    runtime: SessionRuntime,
    from: string,
    to: string,
    context: string,
  ): void {
    this.db.transaction(() => {
      this.setSessionRuntime(id, runtime);
      this.db.prepare("UPDATE sessions SET external_session_id=NULL WHERE id=?").run(id);
      this.db
        .prepare(
          "UPDATE messages SET agent_name=? WHERE session_id=? AND role='model' AND agent_name IS NULL",
        )
        .run(from, id);
      this.saveCheckpoint(id, this.latestTask(id)?.id, context, this.lastMessageId(id));
      this.addMessage(id, {
        role: "model",
        agentName: "Kairo",
        toolName: "agent_handoff",
        content: `Switched from ${from} to ${to}. Continuing this conversation with a fresh agent session and the handoff below.\n\n${context}`,
        createdAt: Date.now(),
      });
    })();
  }
  setExternalSessionId(id: string, externalId: string): void {
    const result = this.db
      .prepare("UPDATE sessions SET external_session_id=? WHERE id=?")
      .run(externalId, id);
    if (result.changes !== 1) throw new Error("Session not found.");
  }
  /** Reads the permission mode saved for one session. */
  sessionPermissionMode(sessionId: string): WorkspaceEditPermission {
    const row = this.db
      .prepare("SELECT permission_mode FROM sessions WHERE id=?")
      .get(sessionId) as { permission_mode?: string } | undefined;
    return row?.permission_mode === "ask" ? "ask" : "workspace";
  }
  /** Persists a session-local edit approval mode and updates its recency. */
  setSessionPermissionMode(sessionId: string, mode: WorkspaceEditPermission): void {
    this.db
      .prepare("UPDATE sessions SET permission_mode=?, updated_at=? WHERE id=?")
      .run(mode, Date.now(), sessionId);
  }
  /** Loads one session by id, if it still exists. */
  get(id: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT id, workspace_id, COALESCE((SELECT directory FROM task_workspaces WHERE id=sessions.workspace_id), workspace) AS workspace, created_at, updated_at, permission_mode, archived_at, runtime_json, external_session_id, (SELECT status FROM tasks WHERE session_id=sessions.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_task_status, COALESCE(title, (SELECT content FROM messages WHERE session_id=sessions.id AND role='user' ORDER BY id LIMIT 1)) AS title FROM sessions WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    return (
      row && {
        id: String(row.id),
        workspace: String(row.workspace),
        workspaceId: String(row.workspace_id),
        title: sessionTitle(row.title),
        lastTaskStatus:
          row.last_task_status == null ? undefined : (row.last_task_status as TaskStatus),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        permissionMode: row.permission_mode === "ask" ? "ask" : "workspace",
        archivedAt: row.archived_at == null ? undefined : Number(row.archived_at),
        runtime: row.runtime_json
          ? (JSON.parse(String(row.runtime_json)) as SessionRuntime)
          : { kind: "builtin" },
        externalSessionId:
          row.external_session_id == null ? undefined : String(row.external_session_id),
      }
    );
  }
  /** Lists sessions from most recently active to oldest. */
  list(): Session[] {
    return this.listByArchiveState(false);
  }
  /** Lists archived sessions from most recently active to oldest. */
  listArchived(): Session[] {
    return this.listByArchiveState(true);
  }
  private listByArchiveState(archived: boolean): Session[] {
    return (
      this.db
        .prepare(
          `SELECT id, workspace_id, COALESCE((SELECT directory FROM task_workspaces WHERE id=sessions.workspace_id), workspace) AS workspace, created_at, updated_at, permission_mode, archived_at, runtime_json, external_session_id, (SELECT status FROM tasks WHERE session_id=sessions.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_task_status, COALESCE(title, (SELECT content FROM messages WHERE session_id=sessions.id AND role='user' ORDER BY id LIMIT 1)) AS title FROM sessions WHERE archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY updated_at DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r.id),
      workspace: String(r.workspace),
      workspaceId: String(r.workspace_id),
      title: sessionTitle(r.title),
      lastTaskStatus: r.last_task_status == null ? undefined : (r.last_task_status as TaskStatus),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      permissionMode: r.permission_mode === "ask" ? "ask" : "workspace",
      archivedAt: r.archived_at == null ? undefined : Number(r.archived_at),
      runtime: r.runtime_json
        ? (JSON.parse(String(r.runtime_json)) as SessionRuntime)
        : { kind: "builtin" },
      externalSessionId: r.external_session_id == null ? undefined : String(r.external_session_id),
    }));
  }
  /** Archives a session while keeping its conversation available for restoration. */
  archive(id: string): void {
    const result = this.db
      .prepare("UPDATE sessions SET archived_at=?, updated_at=? WHERE id=? AND archived_at IS NULL")
      .run(Date.now(), Date.now(), id);
    if (result.changes !== 1) throw new Error("Active session not found.");
  }
  /** Archives every active session for one workspace and returns the affected ids. */
  archiveWorkspace(workspace: string): string[] {
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM sessions WHERE (workspace=? OR workspace_id IN (SELECT id FROM task_workspaces WHERE repository_path=?)) AND archived_at IS NULL",
        )
        .all(workspace, workspace) as { id: string }[]
    ).map((row) => row.id);
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sessions SET archived_at=?, updated_at=? WHERE (workspace=? OR workspace_id IN (SELECT id FROM task_workspaces WHERE repository_path=?)) AND archived_at IS NULL",
        )
        .run(now, now, workspace, workspace);
    })();
    return ids;
  }
  /** Restores an archived session to the recent chats list. */
  restore(id: string): void {
    const result = this.db
      .prepare(
        "UPDATE sessions SET archived_at=NULL, updated_at=? WHERE id=? AND archived_at IS NOT NULL",
      )
      .run(Date.now(), id);
    if (result.changes !== 1) throw new Error("Archived session not found.");
  }
  /** Permanently removes a session and its task/message history. */
  delete(id: string): void {
    this.db.transaction(() => this.deleteSessionRows(id))();
  }
  /** Permanently removes every active and archived session for one workspace. */
  deleteWorkspace(workspace: string): string[] {
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM sessions WHERE workspace=? OR workspace_id IN (SELECT id FROM task_workspaces WHERE repository_path=?)",
        )
        .all(workspace, workspace) as {
        id: string;
      }[]
    ).map((row) => row.id);
    this.db.transaction(() => {
      for (const id of ids) this.deleteSessionRows(id);
    })();
    return ids;
  }
  /** Permanently removes every archived session and returns the affected ids. */
  deleteArchived(): string[] {
    const ids = this.listArchived().map((session) => session.id);
    this.db.transaction(() => {
      for (const id of ids) this.deleteSessionRows(id);
    })();
    return ids;
  }
  private deleteSessionRows(id: string): void {
    if (!this.get(id)) throw new Error("Session not found.");
    this.db
      .prepare(
        "DELETE FROM repair_attempts WHERE task_id IN (SELECT id FROM tasks WHERE session_id=?)",
      )
      .run(id);
    this.db
      .prepare("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE session_id=?)")
      .run(id);
    for (const table of ["messages", "tool_events", "context_checkpoints", "repository_profiles"])
      this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
    this.db.prepare("DELETE FROM tasks WHERE session_id=?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
  latestAgentHandoff(sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT content FROM messages WHERE session_id=? AND tool_name='agent_handoff' ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId) as { content: string } | undefined;
    if (!row) return undefined;
    const start = row.content.indexOf("\n\n");
    return start < 0 ? undefined : row.content.slice(start + 2);
  }
  /** Loads all messages required to reconstruct a full conversation. */
  messages(sessionId: string): Message[] {
    return (
      this.db
        .prepare(
          "SELECT role, content, tool_call_id, tool_name, created_at, agent_name FROM messages WHERE session_id=? ORDER BY id",
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((r) => ({
      agentName: r.agent_name == null ? undefined : String(r.agent_name),
      role: r.role as Message["role"],
      content: String(r.content),
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : undefined,
      toolName: r.tool_name ? String(r.tool_name) : undefined,
      createdAt: Number(r.created_at),
    }));
  }
  /** Loads only the newest messages for bounded model context. */
  recentMessages(sessionId: string, limit: number): Message[] {
    return (
      this.db
        .prepare(
          "SELECT role, content, tool_call_id, tool_name, created_at, agent_name FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
        )
        .all(sessionId, limit) as Record<string, unknown>[]
    ).map((r) => ({
      agentName: r.agent_name == null ? undefined : String(r.agent_name),
      role: r.role as Message["role"],
      content: String(r.content),
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : undefined,
      toolName: r.tool_name ? String(r.tool_name) : undefined,
      createdAt: Number(r.created_at),
    }));
  }
  /** Appends one durable message and refreshes the owning session timestamp. */
  addMessage(sessionId: string, message: Message): void {
    this.db
      .prepare(
        "INSERT INTO messages(session_id, role, content, tool_call_id, tool_name, created_at, agent_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.createdAt,
        message.agentName ?? null,
      );
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(Date.now(), sessionId);
  }
  /** Records the requested action, approval decision, and visible tool output. */
  recordTool(
    sessionId: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
    approved: boolean | null,
    output: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO tool_events(session_id, call_id, name, args_json, approved, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId,
        id,
        name,
        JSON.stringify(args),
        approved === null ? null : Number(approved),
        output,
        Date.now(),
      );
  }
  /** Creates a new task in the initial planning state. */
  startTask(sessionId: string, prompt: string, mode: TaskMode = "implementation"): Task {
    const now = Date.now();
    const id = `task-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO tasks(id, session_id, prompt, mode, status, changed_files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, prompt, mode, "planning", "[]", now, now);
    this.recordTaskEvent({ taskId: id, kind: "status", outcome: "planning", createdAt: now });
    return this.task(id)!;
  }
  /** Loads one task by id and maps database columns to domain names. */
  task(id: string): Task | undefined {
    return this.toTask(
      this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
        Record<string, unknown> | undefined,
    );
  }
  /** Finds the newest task belonging to a session. */
  latestTask(sessionId: string): Task | undefined {
    return this.toTask(
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE session_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
        )
        .get(sessionId) as Record<string, unknown> | undefined,
    );
  }
  /** Finds the most recently saved planning artifact in a session. */
  latestPlan(sessionId: string): Task | undefined {
    return this.toTask(
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE session_id=? AND mode='planning' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(sessionId) as Record<string, unknown> | undefined,
    );
  }
  /** Merges a partial task update and writes the complete task state atomically. */
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | "status"
        | "mode"
        | "plan"
        | "changedFiles"
        | "approvedWritePaths"
        | "verificationCommand"
        | "verificationOutput"
        | "verificationPassed"
        | "verificationExitCode"
        | "verificationDiscovered"
        | "verificationSelection"
        | "summary"
        | "error"
      >
    >,
  ): Task {
    const task = this.task(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    const next = { ...task, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        "UPDATE tasks SET mode=?, status=?, plan_json=?, changed_files_json=?, approved_write_paths_json=?, verification_command=?, verification_output=?, verification_ok=?, verification_exit_code=?, verification_discovered=?, verification_selection_json=?, summary=?, error=?, updated_at=? WHERE id=?",
      )
      .run(
        next.mode,
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        JSON.stringify(next.changedFiles),
        JSON.stringify(next.approvedWritePaths),
        next.verificationCommand ?? null,
        next.verificationOutput ?? null,
        next.verificationPassed === undefined ? null : Number(next.verificationPassed),
        next.verificationExitCode ?? null,
        next.verificationDiscovered === undefined ? null : Number(next.verificationDiscovered),
        next.verificationSelection ? JSON.stringify(next.verificationSelection) : null,
        next.summary ?? null,
        next.error ?? null,
        next.updatedAt,
        id,
      );
    if (next.status !== task.status)
      this.recordTaskEvent({
        taskId: id,
        kind: "status",
        outcome: next.status,
        createdAt: next.updatedAt,
      });
    return next;
  }
  /** Persists a summary that replaces older conversation detail in future context. */
  saveCheckpoint(
    sessionId: string,
    taskId: string | undefined,
    summary: string,
    throughMessageId: number,
  ): ContextCheckpoint {
    const checkpoint: ContextCheckpoint = {
      id: `checkpoint-${crypto.randomUUID()}`,
      sessionId,
      taskId,
      summary,
      throughMessageId,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO context_checkpoints VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.taskId ?? null,
        checkpoint.summary,
        checkpoint.throughMessageId,
        checkpoint.createdAt,
      );
    return checkpoint;
  }
  /** Retrieves the most recent compaction checkpoint for a session. */
  latestCheckpoint(sessionId: string): ContextCheckpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM context_checkpoints WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return (
      row && {
        id: String(row.id),
        sessionId: String(row.session_id),
        taskId: row.task_id ? String(row.task_id) : undefined,
        summary: String(row.summary),
        throughMessageId: Number(row.through_message_id),
        createdAt: Number(row.created_at),
      }
    );
  }
  /** Counts messages to decide when automatic compaction is needed. */
  messageCount(sessionId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT count(*) AS count FROM messages WHERE session_id=?")
          .get(sessionId) as { count: number }
      ).count,
    );
  }
  /** Returns the newest message id used to mark checkpoint coverage. */
  lastMessageId(sessionId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT coalesce(max(id), 0) AS id FROM messages WHERE session_id=?")
          .get(sessionId) as { id: number }
      ).id,
    );
  }
  /** Upserts the session's bounded, derived repository snapshot. */
  saveRepositorySnapshot(sessionId: string, snapshot: RepositorySnapshot): void {
    this.db
      .prepare(
        "INSERT INTO repository_profiles(session_id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at",
      )
      .run(sessionId, JSON.stringify(snapshot), Date.now());
  }
  /** Reads current snapshots and normalizes legacy profiles as stale snapshots. */
  repositorySnapshot(sessionId: string): RepositorySnapshot | undefined {
    const row = this.db
      .prepare("SELECT profile_json FROM repository_profiles WHERE session_id=?")
      .get(sessionId) as { profile_json: string } | undefined;
    if (!row) return undefined;
    const value = JSON.parse(row.profile_json) as Partial<RepositorySnapshot>;
    if (value.schemaVersion === 1 && value.fingerprint && Array.isArray(value.entries))
      return value as RepositorySnapshot;
    return {
      ...(value as Omit<RepositorySnapshot, "schemaVersion" | "fingerprint">),
      schemaVersion: 1,
      fingerprint: { value: "legacy-stale", kind: "filesystem" },
      entries: value.entries ?? [],
      ecosystems: value.ecosystems ?? [],
      changedPaths: value.changedPaths ?? [],
      instructionFiles: value.instructionFiles ?? [],
      documentationFiles: value.documentationFiles ?? [],
      manifestFiles: value.manifestFiles ?? [],
      ciFiles: value.ciFiles ?? [],
      buildFiles: value.buildFiles ?? [],
      truncated: value.truncated ?? false,
    } as RepositorySnapshot;
  }
  /** Persists one verification failure that started an agent repair cycle. */
  recordRepairAttempt(attempt: RepairAttempt): void {
    this.recordTaskEvent({ taskId: attempt.taskId, kind: "repair", createdAt: attempt.createdAt });
    this.db
      .prepare(
        "INSERT INTO repair_attempts(id, task_id, command, evidence_json, selected_files_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        attempt.id,
        attempt.taskId,
        attempt.command,
        JSON.stringify(attempt.evidence),
        JSON.stringify(attempt.selectedFiles),
        attempt.createdAt,
      );
  }
  /** Returns repair attempts in the order they happened for context and evaluation. */
  repairAttempts(taskId: string): RepairAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM repair_attempts WHERE task_id=? ORDER BY created_at")
        .all(taskId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      command: String(row.command),
      evidence: JSON.parse(String(row.evidence_json)) as RepairAttempt["evidence"],
      selectedFiles: JSON.parse(String(row.selected_files_json)) as string[],
      createdAt: Number(row.created_at),
    }));
  }
  /** Marks tasks left active by a process exit so the user can explicitly resume them. */
  private recoverInterruptedTasks(): void {
    const active = this.db
      .prepare("SELECT id FROM tasks WHERE status IN ('planning', 'acting', 'verifying')")
      .all() as { id: string }[];
    for (const task of active)
      this.recordTaskEvent({
        taskId: task.id,
        kind: "status",
        outcome: "interrupted",
        createdAt: Date.now(),
      });
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted', updated_at=? WHERE status IN ('planning', 'acting', 'verifying')",
      )
      .run(Date.now());
  }
  /** Converts a raw SQLite row into the application's Task object. */
  private toTask(row: Record<string, unknown> | undefined): Task | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      prompt: String(row.prompt),
      mode: (row.mode ? String(row.mode) : "implementation") as TaskMode,
      status: row.status as TaskStatus,
      plan: row.plan_json ? (JSON.parse(String(row.plan_json)) as TaskPlan) : undefined,
      changedFiles: JSON.parse(String(row.changed_files_json)) as string[],
      approvedWritePaths: row.approved_write_paths_json
        ? (JSON.parse(String(row.approved_write_paths_json)) as string[])
        : [],
      verificationCommand: row.verification_command ? String(row.verification_command) : undefined,
      verificationOutput: row.verification_output ? String(row.verification_output) : undefined,
      verificationPassed:
        row.verification_ok === null || row.verification_ok === undefined
          ? undefined
          : Boolean(row.verification_ok),
      verificationExitCode:
        row.verification_exit_code === null || row.verification_exit_code === undefined
          ? undefined
          : Number(row.verification_exit_code),
      verificationDiscovered:
        row.verification_discovered === null || row.verification_discovered === undefined
          ? undefined
          : Boolean(row.verification_discovered),
      verificationSelection: row.verification_selection_json
        ? (JSON.parse(String(row.verification_selection_json)) as VerificationSelection)
        : undefined,
      summary: row.summary ? String(row.summary) : undefined,
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  /** Converts one evaluation run row while keeping persistence column names private. */
  private toEvaluationRun(row: Record<string, unknown>): EvaluationRun {
    return {
      id: String(row.id),
      suite: row.suite as "self",
      provider: (row.provider ? String(row.provider) : "gemini") as EvaluationRun["provider"],
      model: String(row.model),
      sourceRevision: String(row.source_revision),
      trialCount: Number(row.trial_count),
      attemptCount: Number(row.attempt_count),
      passedCount: Number(row.passed_count),
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? undefined : Number(row.completed_at),
    };
  }
}
