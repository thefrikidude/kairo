import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { SessionStore } from "./store.js";
import { WorkspaceTools } from "./tools.js";
import type { ApprovalPolicy, ModelProvider, ModelTurn, Message, ToolCall } from "./types.js";

class FakeProvider implements ModelProvider { private n = 0; async stream(_messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn> { this.n += 1; if (this.n === 1) return { text: "", toolCalls: [{ id: "call", name: "write_file", args: { path: "a.txt", content: "x" } }] }; onText("done"); return { text: "done", toolCalls: [] }; } }
class Deny implements ApprovalPolicy { async approve(_call: ToolCall, _description: string): Promise<boolean> { return false; } }
test("agent records denied mutating calls and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-agent-")); const store = await SessionStore.open(join(root, "db.sqlite")); const session = store.create(root);
  const agent = new Agent(new FakeProvider(), store, await WorkspaceTools.create(root), new Deny()); let output = "";
  await agent.run(session.id, "change it", (text) => { output += text; });
  assert.match(output, /Denied/); assert.match(output, /done/); assert.match(store.messages(session.id).map((item) => item.content).join("\n"), /User denied/);
  store.close();
});
