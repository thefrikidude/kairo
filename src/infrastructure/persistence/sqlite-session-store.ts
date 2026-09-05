import Database from "better-sqlite3";
import { databasePath, ensureStateDir } from "../filesystem/platform-paths.js";
import type {
  ContextCheckpoint,
  Message,
  TaskEvent,
  RepairAttempt,
  RepositoryProfile,
  Task,
  TaskStatus,
} from "../../domain/models.js";

export interface Session {
  id: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
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
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, created_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS tool_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT NOT NULL, approved INTEGER, output TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, changed_files_json TEXT NOT NULL DEFAULT '[]', verification_command TEXT, verification_output TEXT, verification_ok INTEGER, verification_exit_code INTEGER, verification_discovered INTEGER, summary TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE INDEX IF NOT EXISTS tasks_session_updated ON tasks(session_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS context_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, summary TEXT NOT NULL, through_message_id INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE INDEX IF NOT EXISTS checkpoints_session_created ON context_checkpoints(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS repository_profiles (session_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));`);
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
    const store = new SqliteSessionStore(db);
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id)",
    );
    store.recoverInterruptedTasks();
    return store;
  }
  /** Closes the SQLite handle after the CLI session exits. */
  close(): void {
    this.db.close();
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
  create(workspace: string): Session {
    const now = Date.now();
    const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(id, workspace, now, now);
    return { id, workspace, createdAt: now, updatedAt: now };
  }
  /** Loads one session by id, if it still exists. */
  get(id: string): Session | undefined {
    const row = this.db
      .prepare("SELECT id, workspace, created_at, updated_at FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return (
      row && {
        id: String(row.id),
        workspace: String(row.workspace),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }
    );
  }
  /** Lists sessions from most recently active to oldest. */
  list(): Session[] {
    return (
      this.db
        .prepare(
          "SELECT id, workspace, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r.id),
      workspace: String(r.workspace),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }
  /** Loads all messages required to reconstruct a full conversation. */
  messages(sessionId: string): Message[] {
    return (
      this.db
        .prepare(
          "SELECT role, content, tool_call_id, tool_name, created_at FROM messages WHERE session_id=? ORDER BY id",
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((r) => ({
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
          "SELECT role, content, tool_call_id, tool_name, created_at FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
        )
        .all(sessionId, limit) as Record<string, unknown>[]
    ).map((r) => ({
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
        "INSERT INTO messages(session_id, role, content, tool_call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sessionId,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.createdAt,
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
  startTask(sessionId: string, prompt: string): Task {
    const now = Date.now();
    const id = `task-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO tasks(id, session_id, prompt, status, changed_files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, prompt, "planning", "[]", now, now);
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
        .prepare("SELECT * FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT 1")
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
        | "changedFiles"
        | "verificationCommand"
        | "verificationOutput"
        | "verificationPassed"
        | "verificationExitCode"
        | "verificationDiscovered"
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
        "UPDATE tasks SET status=?, changed_files_json=?, verification_command=?, verification_output=?, verification_ok=?, verification_exit_code=?, verification_discovered=?, summary=?, error=?, updated_at=? WHERE id=?",
      )
      .run(
        next.status,
        JSON.stringify(next.changedFiles),
        next.verificationCommand ?? null,
        next.verificationOutput ?? null,
        next.verificationPassed === undefined ? null : Number(next.verificationPassed),
        next.verificationExitCode ?? null,
        next.verificationDiscovered === undefined ? null : Number(next.verificationDiscovered),
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
        "SELECT * FROM context_checkpoints WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
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
  /** Upserts the session's bounded repository intelligence profile. */
  saveRepositoryProfile(sessionId: string, profile: RepositoryProfile): void {
    this.db
      .prepare(
        "INSERT INTO repository_profiles(session_id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at",
      )
      .run(sessionId, JSON.stringify(profile), Date.now());
  }
  /** Reads the saved profile so a resumed session does not need to rediscover files. */
  repositoryProfile(sessionId: string): RepositoryProfile | undefined {
    const row = this.db
      .prepare("SELECT profile_json FROM repository_profiles WHERE session_id=?")
      .get(sessionId) as { profile_json: string } | undefined;
    return row ? (JSON.parse(row.profile_json) as RepositoryProfile) : undefined;
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
      status: row.status as TaskStatus,
      changedFiles: JSON.parse(String(row.changed_files_json)) as string[],
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
      summary: row.summary ? String(row.summary) : undefined,
      error: row.error ? String(row.error) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
