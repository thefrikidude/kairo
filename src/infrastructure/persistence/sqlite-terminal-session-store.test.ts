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
    store.close();
    store = await SqliteTerminalSessionStore.open(path);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(session.id)!.title, "Fix the bug");
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
