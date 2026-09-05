import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import type { ModelTurn, Message, ToolCall } from "../domain/models.js";
import type { ApprovalPolicy, ModelProvider } from "../domain/ports.js";

class FakeProvider implements ModelProvider {
  private n = 0;
  async stream(_messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn> {
    this.n += 1;
    if (this.n === 1)
      return {
        text: "",
        toolCalls: [
          {
            id: "call",
            name: "write_file",
            args: { path: "a.txt", content: "x" },
          },
        ],
      };
    onText("done");
    return { text: "done", toolCalls: [] };
  }
}
class Deny implements ApprovalPolicy {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return false;
  }
}
class Allow implements ApprovalPolicy {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}
test("agent records denied mutating calls and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-agent-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  const agent = new CodingAgent(
    new FakeProvider(),
    store,
    await WorkspaceTools.create(root),
    new Deny(),
    definitions,
  );
  let output = "";
  await agent.run(session.id, "change it", (text) => {
    output += text;
  });
  assert.match(output, /Denied/);
  const metrics = taskMetrics(store.taskEvents(store.latestTask(session.id)!.id));
  assert.equal(metrics.modelTurns, 2);
  assert.equal(metrics.toolRequests, 1);
  assert.equal(metrics.toolExecutions, 0);
  assert.equal(metrics.denials, 1);
  assert.equal(metrics.toolFailures, 0);
  assert.match(output, /done/);
  assert.match(
    store
      .messages(session.id)
      .map((item) => item.content)
      .join("\n"),
    /User denied/,
  );
  store.close();
});

test("agent requires verification after a successful edit and records manual verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-verify-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  const agent = new CodingAgent(
    new FakeProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  );
  await agent.run(session.id, "create a file", () => {});
  assert.equal(agent.status(session.id)?.status, "verification_required");
  await agent.verify(session.id, "test -f a.txt", () => {});
  assert.equal(agent.status(session.id)?.status, "completed");
  assert.equal(agent.status(session.id)?.verificationExitCode, 0);
  assert.equal(agent.status(session.id)?.verificationDiscovered, false);
  store.close();
});

test("failed verification does not mark a changed task complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-bad-verify-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  const agent = new CodingAgent(
    new FakeProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  );
  await agent.run(session.id, "create a file", () => {});
  await agent.verify(session.id, "false", () => {});
  assert.equal(agent.status(session.id)?.status, "failed");
  assert.equal(agent.status(session.id)?.verificationPassed, false);
  assert.equal(agent.status(session.id)?.verificationExitCode, 1);
  store.close();
});

class RepeatingProvider implements ModelProvider {
  async stream(_messages: Message[], _onText: (chunk: string) => void): Promise<ModelTurn> {
    return {
      text: "",
      toolCalls: [
        {
          id: crypto.randomUUID(),
          name: "read_file",
          args: { path: "missing.txt" },
        },
      ],
    };
  }
}

class RepairingProvider implements ModelProvider {
  private turn = 0;
  async stream(messages: Message[], _onText: (chunk: string) => void): Promise<ModelTurn> {
    this.turn += 1;
    if (this.turn === 1)
      return {
        text: "",
        toolCalls: [{ id: "write", name: "write_file", args: { path: "a.txt", content: "x" } }],
      };
    if (this.turn === 2)
      return {
        text: "",
        toolCalls: [{ id: "fail", name: "run_command", args: { command: "false" } }],
      };
    if (this.turn === 3) {
      assert.ok(messages.some((message) => message.content.includes("Repair attempt 1/2")));
      return {
        text: "",
        toolCalls: [
          { id: "edit", name: "edit_file", args: { path: "a.txt", oldText: "x", newText: "y" } },
        ],
      };
    }
    if (this.turn === 4)
      return {
        text: "",
        toolCalls: [{ id: "verify", name: "run_command", args: { command: "test -f a.txt" } }],
      };
    return { text: "repaired", toolCalls: [] };
  }
}

test("agent continues with a persisted, focused repair after failed verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-repair-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  const agent = new CodingAgent(
    new RepairingProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  );
  await agent.run(session.id, "create a file", () => {});
  const task = agent.status(session.id)!;
  assert.equal(task.status, "completed");
  assert.equal(store.repairAttempts(task.id).length, 1);
  assert.equal(store.repairAttempts(task.id)[0]?.command, "false");
  const events = store.taskEvents(task.id);
  const metrics = taskMetrics(events);
  assert.equal(metrics.repairs, 1);
  assert.equal(metrics.modelTurns, 5);
  assert.equal(metrics.toolExecutions, 4);
  assert.equal(metrics.approvals, 4);
  assert.equal(metrics.verificationPasses, 1);
  assert.equal(metrics.verificationFailures, 1);
  assert.equal(metrics.unfinishedOperations, 0);
  assert.ok(metrics.modelMs >= 0);
  assert.equal(events.at(-1)?.outcome, "completed");
  store.close();
});

class ExhaustedRepairProvider implements ModelProvider {
  private turn = 0;
  async stream(_messages: Message[], _onText: (chunk: string) => void): Promise<ModelTurn> {
    this.turn += 1;
    if (this.turn === 1)
      return {
        text: "",
        toolCalls: [{ id: "write", name: "write_file", args: { path: "a.txt", content: "x" } }],
      };
    return {
      text: "",
      toolCalls: [
        {
          id: `failure-${this.turn}`,
          name: "run_command",
          args: { command: `false # ${this.turn}` },
        },
      ],
    };
  }
}

test("agent stops after the bounded repair budget is exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-repair-limit-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  await new CodingAgent(
    new ExhaustedRepairProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  ).run(session.id, "create a file", () => {});
  const task = store.latestTask(session.id)!;
  assert.equal(task.status, "failed");
  assert.match(task.error!, /Repair limit reached/);
  assert.equal(store.repairAttempts(task.id).length, 2);
  store.close();
});
test("agent stops repeated failing tool calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-loop-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  let output = "";
  await new CodingAgent(
    new RepeatingProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  ).run(session.id, "read it", (text) => {
    output += text;
  });
  assert.equal(store.latestTask(session.id)?.status, "failed");
  assert.match(output, /Repeated identical tool call blocked/);
  store.close();
});
