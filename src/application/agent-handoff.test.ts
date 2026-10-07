import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { buildAgentHandoff } from "./agent-handoff.js";
import { ContextManager } from "./context-manager.js";

test("handoff bounds verbose evidence while keeping the latest user correction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-handoff-"));
  const store = await SqliteSessionStore.open(join(root, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root);
  for (let index = 0; index < 30; index++)
    store.addMessage(session.id, { role: "model", content: "x".repeat(5000), createdAt: index });
  store.addMessage(session.id, {
    role: "user",
    content: "LATEST_CORRECTION: preserve existing API",
    createdAt: 31,
  });
  const task = store.startTask(session.id, "Implement feature", "implementation");
  store.updateTask(task.id, {
    verificationCommand: "z".repeat(40000),
    verificationOutput: "y".repeat(40000),
  });
  const context = buildAgentHandoff(store, session.id, root);
  assert.ok(context.length <= 24100);
  assert.match(context, /LATEST_CORRECTION/);
});

test("switch handoff remains in builtin context when long history triggers compaction", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const root = await mkdtemp(join(tmpdir(), "kairo-handoff-"));
  const store = await SqliteSessionStore.open(join(root, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root, { kind: "external", agentId: "codex" });
  for (let index = 0; index < 50; index++)
    store.addMessage(session.id, { role: "model", content: `Turn ${index}`, createdAt: index });
  const handoff = "Kairo task handoff\n\nIMPORTANT_HANDOFF_CONSTRAINT: preserve API";
  store.switchSessionRuntime(session.id, { kind: "builtin" }, "Codex", "Kairo", handoff);
  const task = store.startTask(session.id, "Continue", "implementation");
  const context = await new ContextManager(store).prepare(session.id, task);
  assert.ok(context.some((message) => message.role === "user" && message.content === handoff));
  assert.equal(context.filter((message) => message.toolName === "agent_handoff").length, 0);
});
