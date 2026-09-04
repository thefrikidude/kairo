import Database from "better-sqlite3";
import { databasePath, ensureStateDir } from "../filesystem/platform-paths.js";
import type {
  ContextCheckpoint,
  Message,
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
  private constructor(private readonly db: Database.Database) {}
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
    store.recoverInterruptedTasks();
    return store;
  }
  close(): void {
    this.db.close();
  }
  create(workspace: string): Session {
    const now = Date.now();
    const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(id, workspace, now, now);
    return { id, workspace, createdAt: now, updatedAt: now };
  }
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
  startTask(sessionId: string, prompt: string): Task {
    const now = Date.now();
    const id = `task-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO tasks(id, session_id, prompt, status, changed_files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, prompt, "planning", "[]", now, now);
    return this.task(id)!;
  }
  task(id: string): Task | undefined {
    return this.toTask(
      this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
        Record<string, unknown> | undefined,
    );
  }
  latestTask(sessionId: string): Task | undefined {
    return this.toTask(
      this.db
        .prepare("SELECT * FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT 1")
        .get(sessionId) as Record<string, unknown> | undefined,
    );
  }
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
    return next;
  }
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
  messageCount(sessionId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT count(*) AS count FROM messages WHERE session_id=?")
          .get(sessionId) as { count: number }
      ).count,
    );
  }
  lastMessageId(sessionId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT coalesce(max(id), 0) AS id FROM messages WHERE session_id=?")
          .get(sessionId) as { id: number }
      ).id,
    );
  }
  saveRepositoryProfile(sessionId: string, profile: RepositoryProfile): void {
    this.db
      .prepare(
        "INSERT INTO repository_profiles(session_id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at",
      )
      .run(sessionId, JSON.stringify(profile), Date.now());
  }
  repositoryProfile(sessionId: string): RepositoryProfile | undefined {
    const row = this.db
      .prepare("SELECT profile_json FROM repository_profiles WHERE session_id=?")
      .get(sessionId) as { profile_json: string } | undefined;
    return row ? (JSON.parse(row.profile_json) as RepositoryProfile) : undefined;
  }
  private recoverInterruptedTasks(): void {
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted', updated_at=? WHERE status IN ('planning', 'acting', 'verifying')",
      )
      .run(Date.now());
  }
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
