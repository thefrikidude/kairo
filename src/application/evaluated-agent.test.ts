import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluatedAgent } from "./evaluated-agent.js";
import { CodingAgent } from "./coding-agent.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { ProviderError } from "../domain/provider-error.js";
import { taskMetrics } from "./task-metrics.js";
import { summarizeAttempts } from "./evaluation-comparison.js";
import type { EvaluationAttempt } from "../domain/models.js";

test("evaluation preserves earlier tools and model turns on provider failure and separates progress", async () => {
  const store = await SqliteSessionStore.open(":memory:");
  try {
    const session = store.create("/workspace");
    let turns = 0;
    let progress = "";
    const agent = new CodingAgent(
      {
        async stream(_messages, onText, onProgress) {
          if (++turns === 1) {
            onText("private model content");
            return { text: "", toolCalls: [{ id: "read", name: "read", args: {} }] };
          }
          onProgress?.({ kind: "retry", category: "quota", retry: 1, delayMs: 1000 });
          onProgress?.({ kind: "retry_wait", category: "quota", retry: 1, delayMs: 1000 });
          onProgress?.({ kind: "exhausted", category: "quota", retry: 1, delayMs: 0 });
          throw new ProviderError("quota", true);
        },
      },
      store,
      {
        root: "/workspace",
        description: () => "",
        async execute() {
          return { ok: true, output: "private source" };
        },
      },
      {
        async approve() {
          return true;
        },
      },
      [{ name: "read", mutating: false, description: "", parameters: {} }],
    );
    const failure = await runEvaluatedAgent(agent, session.id, "task", (text) => {
      progress += text;
    });
    const task = store.latestTask(session.id)!;
    const metrics = taskMetrics(store.taskEvents(task.id));
    assert.equal(failure.category, "quota");
    assert.equal(task.status, "failed");
    assert.equal(metrics.modelTurns, 2);
    assert.equal(metrics.toolExecutions, 1);
    assert.equal(metrics.providerRetries, 1);
    assert.equal(metrics.providerWaitMs, 1000);
    assert.match(progress, /retry 1\/3/);
    assert.doesNotMatch(progress, /private/);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ failure, metrics })));
    const attempt: EvaluationAttempt = {
      runId: "r",
      scenarioId: "s",
      trial: 1,
      passed: false,
      taskStatus: "failed",
      verified: false,
      expectationPassed: false,
      failureCategory: "quota",
      metrics,
      durationMs: 1000,
      createdAt: 0,
    };
    const blocked = summarizeAttempts([attempt]);
    assert.equal(blocked.infrastructureFailures, 1);
    assert.equal(blocked.passRate, 0);
    assert.equal(blocked.codingPassRate, null);
    const mixed = summarizeAttempts([
      attempt,
      { ...attempt, passed: true, failureCategory: undefined },
    ]);
    assert.equal(mixed.passRate, 0.5);
    assert.equal(mixed.codingPassRate, 1);
    const legacy = {
      ...attempt,
      failureCategory: "verification" as const,
      metrics: { ...metrics, providerRetries: undefined, providerWaitMs: undefined },
    };
    assert.equal(summarizeAttempts([legacy]).codingAttempts, 1);
    assert.equal(legacy.metrics.providerRetries, undefined);
  } finally {
    store.close();
  }
});
