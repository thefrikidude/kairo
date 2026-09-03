import Database from "better-sqlite3";
import { databasePath, ensureStateDir } from "./paths.js";
import type { Message } from "./types.js";

export interface Session { id: string; workspace: string; createdAt: number; updatedAt: number; }
export class SessionStore {
  private constructor(private readonly db: Database.Database) {}
  static async open(path?: string): Promise<SessionStore> {
    if (!path) await ensureStateDir();
    const db = new Database(path || databasePath());
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, created_at INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS tool_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT NOT NULL, approved INTEGER, output TEXT, created_at INTEGER NOT NULL);`);
    return new SessionStore(db);
  }
  close(): void { this.db.close(); }
  create(workspace: string): Session {
    const now = Date.now(); const id = `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(id, workspace, now, now);
    return { id, workspace, createdAt: now, updatedAt: now };
  }
  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT id, workspace, created_at, updated_at FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row && { id: String(row.id), workspace: String(row.workspace), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  list(): Session[] { return (this.db.prepare("SELECT id, workspace, created_at, updated_at FROM sessions ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map((r) => ({ id: String(r.id), workspace: String(r.workspace), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) })); }
  messages(sessionId: string): Message[] { return (this.db.prepare("SELECT role, content, tool_call_id, tool_name, created_at FROM messages WHERE session_id=? ORDER BY id").all(sessionId) as Record<string, unknown>[]).map((r) => ({ role: r.role as Message["role"], content: String(r.content), toolCallId: r.tool_call_id ? String(r.tool_call_id) : undefined, toolName: r.tool_name ? String(r.tool_name) : undefined, createdAt: Number(r.created_at) })); }
  addMessage(sessionId: string, message: Message): void { this.db.prepare("INSERT INTO messages(session_id, role, content, tool_call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, message.role, message.content, message.toolCallId ?? null, message.toolName ?? null, message.createdAt); this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(Date.now(), sessionId); }
  recordTool(sessionId: string, id: string, name: string, args: Record<string, unknown>, approved: boolean | null, output: string): void { this.db.prepare("INSERT INTO tool_events(session_id, call_id, name, args_json, approved, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, id, name, JSON.stringify(args), approved === null ? null : Number(approved), output, Date.now()); }
}
