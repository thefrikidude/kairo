import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "./context-manager.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";

test("context compacts long history into a durable checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-context-")); const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite")); const session = store.create("/workspace"); const task = store.startTask(session.id, "understand the project");
  for (let index = 0; index < 50; index += 1) store.addMessage(session.id, { role: "user", content: `message ${index}`, createdAt: index });
  const messages = new ContextManager(store).prepare(session.id, task);
  assert.ok(store.latestCheckpoint(session.id)); assert.ok(messages.length <= 33); assert.match(messages[0]!.content, /Context checkpoint/);
  store.close();
});
