import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "./coding-agent.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import type { ModelTurn, Message, ToolCall } from "../domain/models.js";
import type { ApprovalPolicy, ModelProvider } from "../domain/ports.js";

class FakeProvider implements ModelProvider { private n = 0; async stream(_messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn> { this.n += 1; if (this.n === 1) return { text: "", toolCalls: [{ id: "call", name: "write_file", args: { path: "a.txt", content: "x" } }] }; onText("done"); return { text: "done", toolCalls: [] }; } }
class Deny implements ApprovalPolicy { async approve(_call: ToolCall, _description: string): Promise<boolean> { return false; } }
class Allow implements ApprovalPolicy { async approve(_call: ToolCall, _description: string): Promise<boolean> { return true; } }
test("agent records denied mutating calls and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-agent-")); const store = await SqliteSessionStore.open(join(root, "db.sqlite")); const session = store.create(root);
  const agent = new CodingAgent(new FakeProvider(), store, await WorkspaceTools.create(root), new Deny(), definitions); let output = "";
  await agent.run(session.id, "change it", (text) => { output += text; });
  assert.match(output, /Denied/); assert.match(output, /done/); assert.match(store.messages(session.id).map((item) => item.content).join("\n"), /User denied/);
  store.close();
});

test("agent requires verification after a successful edit and records manual verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-verify-")); const store = await SqliteSessionStore.open(join(root, "db.sqlite")); const session = store.create(root);
  const agent = new CodingAgent(new FakeProvider(), store, await WorkspaceTools.create(root), new Allow(), definitions);
  await agent.run(session.id, "create a file", () => {});
  assert.equal(agent.status(session.id)?.status, "verification_required");
  await agent.verify(session.id, "test -f a.txt", () => {});
  assert.equal(agent.status(session.id)?.status, "completed");
  store.close();
});

test("failed verification does not mark a changed task complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-bad-verify-")); const store = await SqliteSessionStore.open(join(root, "db.sqlite")); const session = store.create(root);
  const agent = new CodingAgent(new FakeProvider(), store, await WorkspaceTools.create(root), new Allow(), definitions);
  await agent.run(session.id, "create a file", () => {});
  await agent.verify(session.id, "false", () => {});
  assert.equal(agent.status(session.id)?.status, "failed"); assert.equal(agent.status(session.id)?.verificationPassed, false);
  store.close();
});

class RepeatingProvider implements ModelProvider { async stream(_messages: Message[], _onText: (chunk: string) => void): Promise<ModelTurn> { return { text: "", toolCalls: [{ id: crypto.randomUUID(), name: "read_file", args: { path: "missing.txt" } }] }; } }
test("agent stops repeated failing tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-loop-")); const store = await SqliteSessionStore.open(join(root, "db.sqlite")); const session = store.create(root); let output = "";
  await new CodingAgent(new RepeatingProvider(), store, await WorkspaceTools.create(root), new Allow(), definitions).run(session.id, "read it", (text) => { output += text; });
  assert.equal(store.latestTask(session.id)?.status, "failed"); assert.match(output, /Repeated identical tool call blocked/);
  store.close();
});
