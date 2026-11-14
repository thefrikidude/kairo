import { basename } from "node:path";
import type { ProjectPreferences, WorkspaceOperation } from "../../domain/task-workspace.js";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { TaskWorkspace } from "../../domain/task-workspace.js";
import type { ChatEvent, ChatThread } from "../../domain/chat.js";
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
      const columns = new Set(
        (db.prepare("PRAGMA table_info(task_workspaces)").all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      for (const [column, type] of Object.entries({
        name: "TEXT",
        pinned: "INTEGER DEFAULT 0",
        archived_at: "INTEGER",
        last_tab: "TEXT",
        unavailable: "INTEGER DEFAULT 0",
      }))
        if (!columns.has(column))
          db.exec(`ALTER TABLE task_workspaces ADD COLUMN ${column} ${type}`);
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_projects (repository_path TEXT PRIMARY KEY, preferences_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_operations (id TEXT PRIMARY KEY, operation_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS registered_projects (repository_path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);`);
      for (const row of db
        .prepare("SELECT id, branch, directory FROM task_workspaces WHERE name IS NULL")
        .all() as { id: string; branch?: string; directory: string }[])
        db.prepare("UPDATE task_workspaces SET name=? WHERE id=?").run(
          row.branch || basename(row.directory),
          row.id,
        );
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
      // Later changes are numbered; everything above is the idempotent baseline for older databases.
      if ((db.pragma("user_version", { simple: true }) as number) < 2) {
        db.transaction(() => {
          db.exec(`ALTER TABLE terminal_sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'pty';
            ALTER TABLE terminal_sessions ADD COLUMN delegated_from TEXT;
            ALTER TABLE task_workspaces ADD COLUMN chat INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE chat_threads (workspace_id TEXT PRIMARY KEY, agent_id TEXT);
            CREATE TABLE chat_events (
              workspace_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
              text TEXT NOT NULL, agent_id TEXT, created_at INTEGER NOT NULL,
              PRIMARY KEY (workspace_id, seq)
            );`);
          db.pragma("user_version = 2");
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
    let previous = this.workspaces(true).find((item) => item.directory === input.directory);
    if (previous?.removedAt) {
      if (previous.managed) throw new Error("This workspace was removed. Choose another folder.");
      // Unmanaged folders are only unlisted when their project is deleted, so adding the
      // project again may bring the same folder back.
      this.db.prepare("UPDATE task_workspaces SET removed_at=NULL WHERE id=?").run(previous.id);
      previous = { ...previous, removedAt: undefined, archivedAt: undefined };
    }
    const workspace: TaskWorkspace = {
      ...previous,
      ...input,
      name: previous?.name ?? input.name ?? input.branch ?? basename(input.directory),
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
    this.db
      .prepare("UPDATE task_workspaces SET name=?, chat=? WHERE id=?")
      .run(workspace.name, workspace.chat ? 1 : 0, workspace.id);
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
      name: String(row.name),
      pinned: Boolean(row.pinned),
      archivedAt: row.archived_at == null ? undefined : Number(row.archived_at),
      lastTab: row.last_tab == null ? undefined : String(row.last_tab),
      unavailable: Boolean(row.unavailable),
      chat: Boolean(row.chat),
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
  updateWorkspace(
    id: string,
    changes: {
      name?: string;
      pinned?: boolean;
      archivedAt?: number | null;
      lastTab?: string | null;
      unavailable?: boolean;
    },
  ): void {
    if (!this.workspace(id)) throw new Error("Workspace not found.");
    if (changes.name !== undefined) this.title(changes.name);
    const columns = {
      name: "name",
      pinned: "pinned",
      archivedAt: "archived_at",
      lastTab: "last_tab",
      unavailable: "unavailable",
    } as const;
    this.db.transaction(() => {
      for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
        const value = changes[key];
        if (value !== undefined)
          this.db
            .prepare(`UPDATE task_workspaces SET ${columns[key]}=? WHERE id=?`)
            .run(
              typeof value === "boolean"
                ? Number(value)
                : key === "name"
                  ? this.title(value)
                  : value,
              id,
            );
      }
    })();
  }
  /** Chats created before the `chat` flag existed live directly under the chats root. */
  markChats(chatsRoot: string): void {
    this.db
      .prepare("UPDATE task_workspaces SET chat=1 WHERE repository_path=? AND chat=0")
      .run(chatsRoot);
  }
  chatThread(workspaceId: string): ChatThread {
    const agent = this.db
      .prepare("SELECT agent_id FROM chat_threads WHERE workspace_id=?")
      .get(workspaceId) as { agent_id: string | null } | undefined;
    const rows = this.db
      .prepare("SELECT * FROM chat_events WHERE workspace_id=? ORDER BY seq")
      .all(workspaceId) as Record<string, unknown>[];
    return {
      agentId: agent?.agent_id ?? undefined,
      events: rows.map((row) => ({
        id: String(row.id),
        kind: row.kind as ChatEvent["kind"],
        text: String(row.text),
        agentId: row.agent_id == null ? undefined : String(row.agent_id),
        createdAt: Number(row.created_at),
      })),
    };
  }
  /** Adds events at the end of a chat and optionally records which agent is selected. */
  appendChat(
    workspaceId: string,
    events: Omit<ChatEvent, "id" | "createdAt">[],
    agentId?: string,
  ): ChatThread {
    if (!this.workspace(workspaceId)) throw new Error("Workspace not found.");
    this.db.transaction(() => {
      if (agentId !== undefined)
        this.db
          .prepare(
            "INSERT INTO chat_threads(workspace_id, agent_id) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET agent_id=excluded.agent_id",
          )
          .run(workspaceId, agentId);
      let seq =
        (
          this.db
            .prepare("SELECT MAX(seq) AS seq FROM chat_events WHERE workspace_id=?")
            .get(workspaceId) as { seq: number | null }
        ).seq ?? 0;
      for (const event of events)
        this.db
          .prepare(
            "INSERT INTO chat_events(workspace_id, seq, id, kind, text, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            workspaceId,
            ++seq,
            randomUUID(),
            event.kind,
            event.text,
            event.agentId ?? null,
            Date.now(),
          );
    })();
    return this.chatThread(workspaceId);
  }
  /** Brings in a thread saved by an older version in the renderer; a chat that has history is kept. */
  importChat(workspaceId: string, thread: ChatThread): void {
    if (!this.workspace(workspaceId) || this.chatThread(workspaceId).events.length) return;
    this.appendChat(
      workspaceId,
      thread.events.map(({ kind, text, agentId }) => ({ kind, text, agentId })),
      thread.agentId,
    );
  }
  deleteChat(workspaceId: string): void {
    this.db.prepare("DELETE FROM chat_events WHERE workspace_id=?").run(workspaceId);
    this.db.prepare("DELETE FROM chat_threads WHERE workspace_id=?").run(workspaceId);
  }
  preferences(repositoryPath: string): ProjectPreferences {
    const row = this.db
      .prepare("SELECT preferences_json FROM workspace_projects WHERE repository_path=?")
      .get(repositoryPath) as { preferences_json: string } | undefined;
    return row
      ? JSON.parse(row.preferences_json)
      : { repositoryPath, setupScript: "", copyPaths: [] };
  }
  /** Projects the user added, shown even before they have a workspace. */
  projects(): string[] {
    return (
      this.db
        .prepare("SELECT repository_path FROM registered_projects ORDER BY added_at")
        .all() as { repository_path: string }[]
    ).map((row) => row.repository_path);
  }
  registerProject(repositoryPath: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO registered_projects VALUES (?, ?)")
      .run(repositoryPath, Date.now());
  }
  removeProject(repositoryPath: string): void {
    this.db.prepare("DELETE FROM registered_projects WHERE repository_path=?").run(repositoryPath);
  }
  savePreferences(value: ProjectPreferences): void {
    this.db
      .prepare(
        "INSERT INTO workspace_projects VALUES (?, ?) ON CONFLICT(repository_path) DO UPDATE SET preferences_json=excluded.preferences_json",
      )
      .run(value.repositoryPath, JSON.stringify(value));
  }
  operations(): WorkspaceOperation[] {
    return (
      this.db
        .prepare("SELECT operation_json FROM workspace_operations ORDER BY rowid DESC")
        .all() as { operation_json: string }[]
    ).map((row) => JSON.parse(row.operation_json));
  }
  saveOperation(value: WorkspaceOperation): void {
    this.db
      .prepare(
        "INSERT INTO workspace_operations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET operation_json=excluded.operation_json",
      )
      .run(value.id, JSON.stringify(value));
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
      transport: "pty",
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
      transport: row.transport === "acp" ? "acp" : "pty",
      delegatedFrom: row.delegated_from == null ? undefined : String(row.delegated_from),
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
  setActiveWorkspace(id: string | undefined): void {
    if (!id) {
      this.db.prepare("DELETE FROM desktop_state WHERE key='active_workspace'").run();
      return;
    }
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
    this.updateWorkspace(session.workspaceId, { lastTab: `session:${id}` });
    this.db
      .prepare(
        "INSERT INTO desktop_state(key,value) VALUES ('active_session', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(id);
  }
}
