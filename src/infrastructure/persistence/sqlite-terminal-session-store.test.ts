import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTerminalSessionStore } from "./sqlite-terminal-session-store.js";

test("terminal migration deletes legacy chat data once and preserves workspace ownership and native sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-terminal-store-"));
  const path = join(root, "sessions.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('old');
    CREATE TABLE messages(content TEXT); INSERT INTO messages VALUES ('legacy transcript');
    CREATE TABLE tasks(id TEXT); INSERT INTO tasks VALUES ('legacy task');`);
  legacy.close();
  let store = await SqliteTerminalSessionStore.open(path);
  try {
    const workspace = store.registerWorkspace({
      directory: root,
      repositoryPath: root,
      kind: "worktree",
      managed: true,
      branch: "task-a",
      baseCommit: "a".repeat(40),
    });
    const session = store.create(workspace.id, "codex");
    store.rename(session.id, "Fix the bug");
    store.setNativeSession(session.id, { id: "native-123" });
    store.setActiveSession(session.id);
    store.markStarted(session.id, 1234567890000);
    store.close();
    store = await SqliteTerminalSessionStore.open(path);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(session.id)!.title, "Fix the bug");
    assert.equal(store.get(session.id)!.lastStartedAt, 1234567890000);
    assert.equal(store.get(session.id)!.nativeSession!.id, "native-123");
    assert.equal(store.activeSessionId(), session.id);
    assert.equal(store.activeWorkspaceId(), workspace.id);
    assert.equal(store.workspace(workspace.id)!.managed, true);
    assert.equal(store.workspace(workspace.id)!.baseCommit, "a".repeat(40));
    const inspect = new Database(path, { readonly: true });
    assert.deepEqual(
      inspect
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','messages','tasks')",
        )
        .all(),
      [],
    );
    inspect.close();
    store.archive(session.id);
    assert.equal(store.list().length, 0);
    assert.equal(store.list(true).length, 1);
    store.restore(session.id);
    assert.equal(store.list().length, 1);
    store.markWorkspaceRemoved(workspace.id);
    assert.throws(() => store.create(workspace.id, "codex"), /unavailable/);
    assert.throws(() => store.restore(session.id), /unavailable/);
    store.delete(session.id);
    assert.equal(store.activeSessionId(), undefined);
    assert.equal(store.workspace(workspace.id)!.branch, "task-a");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace metadata migration is additive and preserves names, pins, tabs, archives and native identity on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-workspace-migrate-"));
  const path = join(root, "state.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE task_workspaces (
    id TEXT PRIMARY KEY, repository_path TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, branch TEXT, base_commit TEXT, managed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, removed_at INTEGER);
    CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, native_session_json TEXT);
    INSERT INTO task_workspaces VALUES ('workspace', '/project', '/project/task', 'worktree', 'kairo/task', 'base-proof', 1, 123, NULL);
    INSERT INTO terminal_sessions VALUES ('session', 'workspace', 'codex', 'Agent', 123, 123, NULL, '{"id":"native-proof"}');`);
  legacy.close();
  let store = await SqliteTerminalSessionStore.open(path);
  try {
    assert.equal(store.workspace("workspace")?.name, "kairo/task");
    store.setActiveSession("session");
    store.updateWorkspace("workspace", { name: "Task name", pinned: true, archivedAt: 456 });
    store.savePreferences({
      repositoryPath: "/project",
      setupScript: "pnpm install",
      copyPaths: [".env"],
      baseRef: "main",
    });
    store.close();
    store = await SqliteTerminalSessionStore.open(path);
    assert.equal(store.get("session")?.nativeSession?.id, "native-proof");
    assert.equal(store.get("session")?.archivedAt, undefined);
    assert.equal(store.workspace("workspace")?.baseCommit, "base-proof");
    assert.equal(store.workspace("workspace")?.name, "Task name");
    assert.equal(store.workspace("workspace")?.lastTab, "session:session");
    assert.equal(store.workspace("workspace")?.pinned, true);
    assert.equal(store.workspace("workspace")?.archivedAt, 456);
    assert.equal(store.preferences("/project").setupScript, "pnpm install");
    store.updateWorkspace("workspace", { archivedAt: null });
    assert.equal(store.workspace("workspace")?.archivedAt, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("numbered migration adds transport, chat flag and chat history to an older database exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-chat-migrate-"));
  const path = join(root, "state.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE task_workspaces (
    id TEXT PRIMARY KEY, repository_path TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, branch TEXT, base_commit TEXT, managed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, removed_at INTEGER);
    CREATE TABLE terminal_sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, native_session_json TEXT);
    INSERT INTO task_workspaces VALUES ('chat-1', '/state/chats', '/state/chats/aaaa', 'folder', NULL, NULL, 0, 1, NULL);
    INSERT INTO task_workspaces VALUES ('project-1', '/project', '/project', 'folder', NULL, NULL, 0, 2, NULL);
    INSERT INTO terminal_sessions VALUES ('session', 'project-1', 'codex', 'Agent', 1, 1, NULL, NULL);`);
  legacy.close();
  let store = await SqliteTerminalSessionStore.open(path);
  try {
    assert.equal(store.get("session")?.transport, "pty");
    assert.equal(store.get("session")?.delegatedFrom, undefined);
    // Chats made before the flag are recognised by where they live, and projects are not.
    store.markChats("/state/chats");
    assert.equal(store.workspace("chat-1")?.chat, true);
    assert.equal(store.workspace("project-1")?.chat, false);
    store.close();
    // Opening again must not repeat the migration.
    store = await SqliteTerminalSessionStore.open(path);
    assert.equal(store.workspace("chat-1")?.chat, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("chat history is ordered, keeps the selected agent, imports older threads once and goes with its chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-chat-events-"));
  const store = await SqliteTerminalSessionStore.open(join(root, "state.sqlite"));
  try {
    const chat = store.registerWorkspace({
      repositoryPath: "/state/chats",
      directory: "/state/chats/one",
      kind: "folder",
      managed: false,
      chat: true,
    });
    assert.deepEqual(store.chatThread(chat.id), { agentId: undefined, events: [] });
    store.appendChat(chat.id, [{ kind: "user", text: "hello" }], "claude");
    const thread = store.appendChat(chat.id, [
      { kind: "notice", text: "not delivered" },
      { kind: "switch", text: "Switched to Codex", agentId: "codex" },
    ]);
    assert.equal(thread.agentId, "claude");
    assert.deepEqual(
      thread.events.map((event) => [event.kind, event.text]),
      [
        ["user", "hello"],
        ["notice", "not delivered"],
        ["switch", "Switched to Codex"],
      ],
    );
    assert.equal(thread.events[2]!.agentId, "codex");
    // A thread that already has history is never overwritten by an import.
    store.importChat(chat.id, {
      agentId: "codex",
      events: [{ id: "", kind: "user", text: "old", createdAt: 0 }],
    });
    assert.equal(store.chatThread(chat.id).events.length, 3);
    const other = store.registerWorkspace({
      repositoryPath: "/state/chats",
      directory: "/state/chats/two",
      kind: "folder",
      managed: false,
      chat: true,
    });
    store.importChat(other.id, {
      agentId: "codex",
      events: [{ id: "", kind: "user", text: "kept", createdAt: 0 }],
    });
    assert.equal(store.chatThread(other.id).agentId, "codex");
    assert.equal(store.chatThread(other.id).events[0]?.text, "kept");
    assert.throws(() => store.appendChat("missing", []), /Workspace not found/);
    store.deleteChat(chat.id);
    assert.deepEqual(store.chatThread(chat.id).events, []);
    assert.equal(store.chatThread(other.id).events.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
