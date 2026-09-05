import test from "node:test";
import assert from "node:assert/strict";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";
import { formatMetrics, formatTrace } from "../interface/cli/task-trace.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("failed model turns have a paired outcome and measured latency", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    const agent = new CodingAgent(
      {
        async stream() {
          throw new Error("network unavailable");
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          throw new Error("unexpected");
        },
      },
      {
        async approve() {
          return false;
        },
      },
      [],
    );
    await assert.rejects(
      agent.run(session.id, "hello", () => {}),
      /network unavailable/,
    );
    const task = store.latestTask(session.id)!;
    const events = store.taskEvents(task.id);
    const metrics = taskMetrics(events);
    assert.equal(metrics.modelTurns, 1);
    assert.equal(metrics.modelFailures, 1);
    assert.equal(metrics.unfinishedOperations, 0);
    assert.equal(events.at(-1)?.outcome, "failed");
    assert.ok(formatTrace(task, events).includes("model_finished"));
    assert.ok(!JSON.stringify(events).includes("network unavailable"));
    assert.match(formatMetrics([]), /No trace recorded/);
  } finally {
    store.close();
  }
});

test("restart retains ordered events and exposes an interrupted operation without inventing duration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-trace-"));
  const path = join(dir, "state.sqlite");
  let store = await SqliteSessionStore.open(path);
  try {
    const session = store.create("/workspace");
    const task = store.startTask(session.id, "hello");
    store.recordTaskEvent({
      taskId: task.id,
      kind: "model_started",
      operationId: "pending",
      createdAt: 1,
    });
    store.close();
    store = await SqliteSessionStore.open(path);
    const events = store.taskEvents(task.id);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["status", "model_started", "status"],
    );
    assert.equal(events.at(-1)?.outcome, "interrupted");
    assert.equal(taskMetrics(events).unfinishedOperations, 1);
    assert.equal(taskMetrics(events).modelMs, 0);
    const other = store.startTask(session.id, "another task");
    assert.equal(taskMetrics(store.taskEvents(other.id)).modelTurns, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
