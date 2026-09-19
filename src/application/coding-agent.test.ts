import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import type { ModelTurn, Message, ToolCall } from "../domain/models.js";
import type { ApprovalPolicy, JevSafetyAdvisor, ModelProvider } from "../domain/ports.js";

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

test("Jev enriches but never bypasses mutation approval or retains source content", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    let approvalDescription = "";
    let state = "";
    const advisor: JevSafetyAdvisor = {
      async assess(value) {
        state = value;
        return { risk: "high", confidence: 0.91 };
      },
      async route() {
        return { value: "build", confidence: 1 };
      },
      async recover() {
        return { value: "repair", confidence: 1 };
      },
    };
    const agent = new CodingAgent(
      new FakeProvider(),
      store,
      {
        root: "/workspace",
        description: () => "Write a.txt",
        async execute() {
          return { ok: true, output: "written" };
        },
      },
      {
        async approve(_call, description) {
          approvalDescription = description;
          return true;
        },
      },
      definitions,
      undefined,
      advisor,
    );
    await agent.run(session.id, "Update a file", () => {});
    const task = agent.status(session.id)!;
    assert.match(approvalDescription, /Jev risk: high \(91% confidence\)/);
    assert.match(state, /Tool: write_file/);
    assert.doesNotMatch(state, /content:|written/);
    assert.equal(
      store.taskEvents(task.id).some((event) => event.kind === "jev_completed"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(store.taskEvents(task.id)), /Update a file|written/);
  } finally {
    store.close();
  }
});

test("later edits invalidate a passing check and ordinary commands cannot verify changes", async () => {
  for (const command of ["true", "false"]) {
    const store = await SqliteSessionStore.open(":memory:");
    try {
      const session = store.create("/workspace");
      const turns: ModelTurn[] = [
        {
          text: "",
          toolCalls: [
            { id: "write", name: "write_file", args: { path: "a.ts", content: "first" } },
            { id: "check", name: "run_command", args: { command: "test", verification: true } },
            { id: "edit", name: "write_file", args: { path: "a.ts", content: "second" } },
            { id: "inspect", name: "run_command", args: { command } },
          ],
        },
        { text: "done", toolCalls: [] },
      ];
      const agent = new CodingAgent(
        {
          async stream() {
            return turns.shift()!;
          },
        },
        store,
        {
          root: "/workspace",
          description: () => "test action",
          async execute(call) {
            return {
              ok: call.args.command !== "false",
              output: "",
              exitCode: call.args.command === "false" ? 1 : 0,
            };
          },
        },
        new Allow(),
        definitions,
      );
      await agent.run(session.id, "edit", () => {});
      const task = agent.status(session.id)!;
      assert.equal(task.status, "verification_required");
      assert.equal(task.verificationPassed, undefined);
      assert.equal(store.repairAttempts(task.id).length, 0);
      assert.equal(taskMetrics(store.taskEvents(task.id)).verificationPasses, 1);
      assert.equal(taskMetrics(store.taskEvents(task.id)).verificationFailures, 0);
    } finally {
      store.close();
    }
  }
});
class Allow implements ApprovalPolicy {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}
class DenyCommands implements ApprovalPolicy {
  async approve(call: ToolCall, _description: string): Promise<boolean> {
    return call.name !== "run_command";
  }
}

test("planning saves a structured read-only artifact without requiring approval", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    let approvals = 0;
    const executed: string[] = [];
    const agent = new CodingAgent(
      {
        async stream() {
          return {
            text: "",
            toolCalls: [
              { id: "inspect", name: "read_file", args: { path: "src/app.ts" } },
              {
                id: "plan",
                name: "submit_plan",
                args: {
                  goal: "Add task planning",
                  assumptions: ["The CLI remains terminal-first."],
                  files: [{ path: "src/application/coding-agent.ts", reason: "Coordinate plans." }],
                  steps: ["Add a planning mode.", "Persist the completed plan."],
                  verification: { command: "pnpm test", reason: "Run the agent tests." },
                  risks: ["Models can submit malformed tool arguments."],
                },
              },
            ],
          };
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute(call) {
          executed.push(call.name);
          return { ok: true, output: "source" };
        },
      },
      {
        async approve() {
          approvals += 1;
          return true;
        },
      },
      definitions,
    );
    await agent.plan(session.id, "plan task planning", () => {});
    const task = agent.status(session.id)!;
    assert.equal(task.mode, "planning");
    assert.equal(task.status, "planned");
    assert.equal(task.plan?.goal, "Add task planning");
    assert.deepEqual(executed, ["read_file"]);
    assert.equal(approvals, 0);
    assert.equal(
      store.taskEvents(task.id).some((event) => event.kind === "plan_submitted"),
      true,
    );
  } finally {
    store.close();
  }
});

test("planning treats a conversational response without a plan as completed, not failed", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    const agent = new CodingAgent(
      {
        async stream() {
          return { text: "Hello! How can I help?", toolCalls: [] };
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          return { ok: true, output: "" };
        },
      },
      {
        async approve() {
          return true;
        },
      },
      definitions,
    );
    await agent.plan(session.id, "hello", () => {});
    const task = agent.status(session.id)!;
    assert.equal(task.status, "completed");
    assert.equal(task.plan, undefined);
  } finally {
    store.close();
  }
});

test("high-confidence Jev routing plans only the current BUILD request", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    let routes = 0;
    const advisor: JevSafetyAdvisor = {
      async assess() {
        return { risk: "low", confidence: 1 };
      },
      async route() {
        routes += 1;
        return { value: routes === 1 ? "plan" : "build", confidence: 0.9 };
      },
      async recover() {
        return { value: "repair", confidence: 1 };
      },
    };
    const agent = new CodingAgent(
      {
        async stream() {
          return { text: "done", toolCalls: [] };
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          return { ok: true, output: "" };
        },
      },
      new Allow(),
      definitions,
      undefined,
      advisor,
    );
    await agent.run(session.id, "design a broad migration", () => {});
    const planned = agent.status(session.id)!;
    assert.equal(planned.mode, "planning");
    await agent.run(session.id, "make a focused edit", () => {});
    assert.equal(agent.status(session.id)?.mode, "implementation");
    assert.equal(
      store
        .taskEvents(planned.id)
        .some((event) => event.kind === "jev_completed" && event.name === "route"),
      true,
    );
  } finally {
    store.close();
  }
});

test("planning rejects writes and commands before approval or workspace execution", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    let approvals = 0;
    let executions = 0;
    const agent = new CodingAgent(
      {
        async stream() {
          return {
            text: "",
            toolCalls: [
              { id: "write", name: "write_file", args: { path: "unsafe.txt", content: "no" } },
              { id: "command", name: "run_command", args: { command: "touch unsafe.txt" } },
              { id: "done", name: "submit_plan", args: { bad: true } },
            ],
          };
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          executions += 1;
          return { ok: true, output: "" };
        },
      },
      {
        async approve() {
          approvals += 1;
          return true;
        },
      },
      definitions,
    );
    await agent.plan(session.id, "unsafe plan", () => {});
    assert.equal(approvals, 0);
    assert.equal(executions, 0);
    assert.equal(agent.status(session.id)?.status, "failed");
  } finally {
    store.close();
  }
});

test("model operations record provider and model attribution", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    const agent = new CodingAgent(
      {
        async stream() {
          return { text: "done", toolCalls: [] };
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          return { ok: true, output: "" };
        },
      },
      new Allow(),
      definitions,
      { provider: "groq", model: "openai/gpt-oss-120b" },
    );
    await agent.run(session.id, "inspect", () => {});
    const task = agent.status(session.id)!;
    assert.deepEqual(
      store
        .taskEvents(task.id)
        .filter((event) => event.kind === "model_started" || event.kind === "model_finished")
        .map((event) => event.name),
      ["groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-120b"],
    );
  } finally {
    store.close();
  }
});

function saveVerificationProfile(store: SqliteSessionStore, sessionId: string, root: string): void {
  store.saveRepositoryProfile(sessionId, {
    root,
    packageManager: "pnpm",
    scripts: { test: "test -f a.txt" },
    configFiles: [],
    sourceRoots: ["src"],
    testRoots: ["test"],
    ignoredPaths: [],
    indexedFiles: [],
    files: [],
    verificationCandidates: [{ label: "test", command: "test -f a.txt" }],
    createdAt: Date.now(),
  });
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

test("agent recommends verification and runs it only through approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-recommended-verify-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  saveVerificationProfile(store, session.id, root);
  let output = "";
  await new CodingAgent(
    new FakeProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  ).run(session.id, "create a file", (text) => {
    output += text;
  });
  const task = store.latestTask(session.id)!;
  assert.equal(task.status, "completed");
  assert.equal(task.verificationCommand, "test -f a.txt");
  assert.equal(task.verificationSelection?.source, "recommended");
  assert.equal(task.verificationSelection?.scope, "broad");
  assert.match(output, /Recommended broad verification/);
  assert.equal(taskMetrics(store.taskEvents(task.id)).verificationSelections, 1);
  store.close();
});

test("declining a recommended verification leaves the task awaiting verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-declined-verify-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  saveVerificationProfile(store, session.id, root);
  await new CodingAgent(
    new FakeProvider(),
    store,
    await WorkspaceTools.create(root),
    new DenyCommands(),
    definitions,
  ).run(session.id, "create a file", () => {});
  assert.equal(store.latestTask(session.id)?.status, "verification_required");
  assert.equal(store.latestTask(session.id)?.verificationPassed, undefined);
  store.close();
});

test("a passing project typecheck is followed once by project tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-escalated-verify-"));
  await mkdir(join(root, "src"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  const session = store.create(root);
  store.saveRepositoryProfile(session.id, {
    root,
    packageManager: "pnpm",
    scripts: {},
    configFiles: [],
    sourceRoots: ["src"],
    testRoots: ["test"],
    ignoredPaths: [],
    indexedFiles: [],
    files: [],
    verificationCandidates: [
      { label: "typecheck", command: "test -f src/a.ts" },
      { label: "test", command: "test -f src/a.ts && true" },
    ],
    createdAt: Date.now(),
  });
  class SourceProvider implements ModelProvider {
    private turn = 0;
    async stream(_messages: Message[], _onText: (chunk: string) => void): Promise<ModelTurn> {
      this.turn += 1;
      return this.turn === 1
        ? {
            text: "",
            toolCalls: [
              { id: "write-source", name: "write_file", args: { path: "src/a.ts", content: "x" } },
            ],
          }
        : { text: "done", toolCalls: [] };
    }
  }
  await new CodingAgent(
    new SourceProvider(),
    store,
    await WorkspaceTools.create(root),
    new Allow(),
    definitions,
  ).run(session.id, "change source", () => {});
  const task = store.latestTask(session.id)!;
  const metrics = taskMetrics(store.taskEvents(task.id));
  assert.equal(task.status, "completed");
  assert.equal(task.verificationSelection?.scope, "broad");
  assert.equal(metrics.focusedVerifications, 0);
  assert.equal(metrics.broadVerifications, 2);
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
        toolCalls: [
          { id: "fail", name: "run_command", args: { command: "false", verification: true } },
        ],
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
        toolCalls: [
          {
            id: "verify",
            name: "run_command",
            args: { command: "test -f a.txt", verification: true },
          },
        ],
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

test("Jev can escalate a failed verification without bypassing its original approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-jev-escalate-"));
  const store = await SqliteSessionStore.open(join(root, "db.sqlite"));
  try {
    const session = store.create(root);
    let approvals = 0;
    const advisor: JevSafetyAdvisor = {
      async assess() {
        return { risk: "high", confidence: 0.95 };
      },
      async route() {
        return { value: "build", confidence: 1 };
      },
      async recover() {
        return { value: "escalate", confidence: 0.9 };
      },
    };
    await new CodingAgent(
      new RepairingProvider(),
      store,
      await WorkspaceTools.create(root),
      {
        async approve() {
          approvals += 1;
          return true;
        },
      },
      definitions,
      undefined,
      advisor,
    ).run(session.id, "create a file", () => {});
    const task = store.latestTask(session.id)!;
    assert.equal(task.status, "verification_required");
    assert.equal(store.repairAttempts(task.id).length, 0);
    assert.equal(approvals, 2);
    assert.equal(
      store
        .taskEvents(task.id)
        .some((event) => event.kind === "jev_completed" && event.name === "recovery"),
      true,
    );
  } finally {
    store.close();
  }
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
          args: { command: `false # ${this.turn}`, verification: true },
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
