import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluationSuite } from "./evaluation-harness.js";
import {
  formatEvaluationReport,
  formatEvaluationHistory,
  formatEvaluationRun,
  formatLiveEvaluationReport,
  formatSelfEvaluationReport,
} from "../interface/cli/evaluation-report.js";

test("scripted evaluation verifies fixture state and repair evidence", async () => {
  const results = await runEvaluationSuite();
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.passed));
  assert.equal(results.find((result) => result.id === "create-file")?.verified, true);
  const repair = results.find((result) => result.id === "repair-failing-test");
  assert.equal(repair?.verified, true);
  assert.ok((repair?.metrics.toolExecutions ?? 0) >= 3);
  assert.match(formatEvaluationReport(results), /2\/2 passed/);
});

test("live evaluation report exposes the independent fixture and DeepEval verdict", () => {
  const report = formatLiveEvaluationReport([
    {
      id: "create-file",
      passed: true,
      taskStatus: "completed",
      verified: true,
      expectationPassed: true,
      judge: { passed: true, score: 0.9, reason: "Task completed." },
      metrics: {
        modelTurns: 3,
        toolExecutions: 2,
        toolFailures: 0,
        approvals: 2,
        repairs: 0,
        verificationPasses: 1,
        verificationFailures: 0,
        verificationSelections: 1,
        focusedVerifications: 1,
        broadVerifications: 0,
        repairConverged: false,
        modelMs: 20,
        toolMs: 10,
      },
    },
  ]);
  assert.match(report, /1\/1 passed/);
  assert.match(report, /judge=passed/);
  assert.match(report, /score=0.90/);
});

test("self evaluation report distinguishes repeated live trials", () => {
  const report = formatSelfEvaluationReport([
    {
      id: "verification-check-script",
      trial: 2,
      passed: true,
      taskStatus: "completed",
      verified: true,
      expectationPassed: true,
      metrics: {
        modelTurns: 4,
        toolExecutions: 3,
        toolFailures: 0,
        approvals: 3,
        repairs: 0,
        verificationPasses: 1,
        verificationFailures: 0,
        verificationSelections: 1,
        focusedVerifications: 1,
        broadVerifications: 0,
        repairConverged: false,
        modelMs: 20,
        toolMs: 10,
      },
    },
  ]);
  assert.match(report, /Kairo self evaluation: 1\/1 passed/);
  assert.match(report, /trial=2/);
});

test("saved self-evaluation reports show aggregate metadata and per-task outcomes", () => {
  const run = {
    id: "eval-1",
    suite: "self" as const,
    model: "gemini",
    sourceRevision: "abc",
    trialCount: 1,
    attemptCount: 1,
    passedCount: 1,
    startedAt: 0,
    completedAt: 1,
  };
  const attempt = {
    runId: run.id,
    scenarioId: "safe-read",
    trial: 1,
    passed: true,
    taskStatus: "completed" as const,
    verified: true,
    expectationPassed: true,
    metrics: {
      modelTurns: 1,
      toolExecutions: 2,
      toolFailures: 0,
      approvals: 1,
      repairs: 0,
      verificationPasses: 1,
      verificationFailures: 0,
      verificationSelections: 1,
      focusedVerifications: 0,
      broadVerifications: 1,
      repairConverged: false,
      modelMs: 3,
      toolMs: 4,
    },
    durationMs: 7,
    createdAt: 1,
  };
  assert.match(formatEvaluationHistory([run]), /eval-1/);
  assert.match(formatEvaluationRun(run, [attempt]), /Reliability: 1\/1 passed/);
  assert.match(formatEvaluationRun(run, [attempt]), /safe-read/);
});
