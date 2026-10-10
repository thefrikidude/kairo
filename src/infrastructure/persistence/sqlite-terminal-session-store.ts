import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { TaskWorkspace } from "../../domain/task-workspace.js";
import type { NativeAgentSession, TerminalSession } from "../../domain/terminal-agent.js";
import { agentDefinition, normalizeNativeSession } from "../agents/terminal-agent-catalog.js";
import { databasePath, ensureStateDir } from "../filesystem/platform-paths.js";

/** Terminal metadata is durable; PTY handles and vendor conversations are owned elsewhere. */
export class SqliteTerminalSessionStore {
  private constructor(private readonly db: Database.Database) {}
  static async open(path?: string): Promise<SqliteTerminalSessionStore> {
    if (!path) await ensureStateDir();
    const db = new Database(path ?? databasePath());
    try {
      db.pragma("journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS desktop_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS task_workspaces (
          id TEXT PRIMARY KEY, repository_path TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL, branch TEXT, base_commit TEXT, managed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, removed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS terminal_sessions (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES task_workspaces(id),
          agent_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, archived_at INTEGER, native_session_json TEXT
        );
        CREATE INDEX IF NOT EXISTS terminal_sessions_workspace ON terminal_sessions(workspace_id);
        CREATE TABLE IF NOT EXISTS desktop_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      if (
        !(db.prepare("PRAGMA table_info(terminal_sessions)").all() as { name: string }[]).some(
          (column) => column.name === "last_started_at",
        )
      )
        db.exec("ALTER TABLE terminal_sessions ADD COLUMN last_started_at INTEGER");
      // Explicitly requested reset. Runs once; never deletes terminal sessions or worktrees.
      if (!db.prepare("SELECT 1 FROM desktop_migrations WHERE name=?").get("terminal-desktop-v1")) {
        db.transaction(() => {
          for (const table of [
            "evaluation_baselines",
            "evaluation_attempts",
            "evaluation_runs",
            "repair_attempts",
            "task_events",
            "context_checkpoints",
            "repository_profiles",
            "tool_events",
            "messages",
            "tasks",
            "sessions",
            "schema_version",
          ]) {
            db.exec(`DROP TABLE IF EXISTS ${table}`);
          }
          db.prepare("INSERT INTO desktop_migrations(name, applied_at) VALUES (?, ?)").run(
            "terminal-desktop-v1",
            Date.now(),
          );
        })();
      }
      db.pragma("foreign_keys=ON");
      return new SqliteTerminalSessionStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  registerWorkspace(input: Omit<TaskWorkspace, "id" | "createdAt" | "removedAt">): TaskWorkspace {
    const previous = this.workspaces(true).find((item) => item.directory === input.directory);
    if (previous?.removedAt) throw new Error("This workspace was removed. Choose another folder.");
    const workspace: TaskWorkspace = {
      ...input,
      id: previous?.id ?? `ws-${randomUUID()}`,
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
          .prepare("UPDATE terminal_sessions SET workspace_id=? WHERE workspace_id=?")
          .run(target.id, id);
        this.db.prepare("DELETE FROM task_workspaces WHERE id=?").run(id);
      } else {
        this.db
          .prepare("UPDATE task_workspaces SET directory=? WHERE id=?")
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

  create(workspaceId: string, agentId: string, title?: string): TerminalSession {
    const workspace = this.workspace(workspaceId);
    if (!workspace || workspace.removedAt) throw new Error("Workspace is unavailable.");
    const agent = agentDefinition(agentId);
    const session: TerminalSession = {
      id: randomUUID(),
      workspaceId,
      agentId,
      title: this.title(title ?? agent.name),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        "INSERT INTO terminal_sessions(id, workspace_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(session.id, workspaceId, agentId, session.title, session.createdAt, session.updatedAt);
    return session;
  }
  private title(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 200)
      throw new Error("Enter a session name between 1 and 200 characters.");
    return value.trim().replace(/\s+/g, " ");
  }
  private row(row: Record<string, unknown>): TerminalSession {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastStartedAt: row.last_started_at == null ? undefined : Number(row.last_started_at),
      archivedAt: row.archived_at == null ? undefined : Number(row.archived_at),
      nativeSession:
        row.native_session_json == null
          ? undefined
          : normalizeNativeSession(JSON.parse(String(row.native_session_json))),
    };
  }
  get(id: string): TerminalSession | undefined {
    const row = this.db.prepare("SELECT * FROM terminal_sessions WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.row(row) : undefined;
  }
  list(archived = false): TerminalSession[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM terminal_sessions WHERE archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY updated_at DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => this.row(row));
  }
  rename(id: string, title: unknown): void {
    this.update(id, "title", this.title(title));
  }
  archive(id: string): void {
    this.update(id, "archived_at", Date.now());
  }
  restore(id: string): void {
    const session = this.get(id);
    if (!session || this.workspace(session.workspaceId)?.removedAt)
      throw new Error("This session's workspace is unavailable.");
    this.update(id, "archived_at", null);
  }
  markStarted(id: string, at: number): void {
    if (
      this.db.prepare("UPDATE terminal_sessions SET last_started_at=? WHERE id=?").run(at, id)
        .changes !== 1
    )
      throw new Error("Session not found.");
  }
  clearNativeSession(id: string): void {
    this.update(id, "native_session_json", null);
  }
  setNativeSession(id: string, value: NativeAgentSession): void {
    this.update(id, "native_session_json", JSON.stringify(normalizeNativeSession(value)));
  }
  private update(
    id: string,
    column: "title" | "archived_at" | "native_session_json",
    value: string | number | null,
  ): void {
    const result = this.db
      .prepare(`UPDATE terminal_sessions SET ${column}=?, updated_at=? WHERE id=?`)
      .run(value, Date.now(), id);
    if (result.changes !== 1) throw new Error("Session not found.");
  }
  delete(id: string): void {
    const result = this.db.prepare("DELETE FROM terminal_sessions WHERE id=?").run(id);
    if (result.changes !== 1) throw new Error("Session not found.");
    if (this.activeSessionId() === id) this.setActiveSession(undefined);
  }
  activeWorkspaceId(): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM desktop_state WHERE key='active_workspace'")
      .get() as { value: string } | undefined;
    return row?.value;
  }
  setActiveWorkspace(id: string): void {
    const workspace = this.workspace(id);
    if (!workspace || workspace.removedAt) throw new Error("Choose an available workspace.");
    this.db
      .prepare(
        "INSERT INTO desktop_state(key,value) VALUES ('active_workspace', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(id);
  }
  activeSessionId(): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM desktop_state WHERE key='active_session'")
      .get() as { value: string } | undefined;
    return row?.value;
  }
  setActiveSession(id: string | undefined): void {
    if (!id) {
      this.db.prepare("DELETE FROM desktop_state WHERE key='active_session'").run();
      return;
    }
    const session = this.get(id);
    if (!session || session.archivedAt) throw new Error("Choose an active session.");
    this.setActiveWorkspace(session.workspaceId);
    this.db
      .prepare(
        "INSERT INTO desktop_state(key,value) VALUES ('active_session', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(id);
  }
}
