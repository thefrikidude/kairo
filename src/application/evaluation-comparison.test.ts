import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import {
  compareEvaluations,
  compareWithBaseline,
  summarizeAttempts,
} from "./evaluation-comparison.js";
import type { EvaluationAttempt, EvaluationRun } from "../domain/models.js";

const run: EvaluationRun = {
  id: "base",
  suite: "self",
  provider: "gemini",
  model: "gemini",
  sourceRevision: "abc",
  trialCount: 3,
  attemptCount: 3,
  passedCount: 2,
  startedAt: 0,
  completedAt: 1,
};
/** Creates metadata-only observations with predictable averages. */
function attempt(scenarioId: string, passed: boolean, turns = 2): EvaluationAttempt {
  return {
    runId: run.id,
    scenarioId,
    trial: 1,
    passed,
    taskStatus: passed ? "completed" : "failed",
    verified: passed,
    expectationPassed: passed,
    durationMs: turns * 10,
    createdAt: 0,
    metrics: {
      modelTurns: turns,
      toolExecutions: turns * 2,
      repairs: 1,
      verificationFailures: 1,
      toolFailures: 0,
      approvals: 1,
      verificationPasses: passed ? 1 : 0,
      verificationSelections: 1,
      focusedVerifications: 0,
      broadVerifications: 1,
      repairConverged: false,
      modelMs: 1,
      toolMs: 1,
    },
  };
}

test("comparison weights observed attempts and retains absent scenarios", () => {
  const result = compareEvaluations(
    run,
    [attempt("a", true, 2), attempt("a", false, 4), attempt("b", false, 6)],
    { ...run, id: "next", trialCount: 1 },
    [attempt("a", true, 1), attempt("new", true, 1)],
  );
  assert.equal(result.overall.baseline.passRate, 1 / 3);
  assert.equal(result.overall.current.passRate, 1);
  assert.equal(result.overall.delta?.passed, 1);
  assert.equal(result.overall.delta?.averages.modelTurns, -3);
  assert.equal(result.overall.delta?.averages.toolExecutions, -6);
  assert.equal(result.overall.delta?.averages.durationMs, -30);
  assert.equal(result.scenarios.find((item) => item.scenarioId === "b")?.delta?.passRate, null);
  assert.equal(result.scenarios.find((item) => item.scenarioId === "new")?.baseline.attempts, 0);
  assert.equal(summarizeAttempts([]).passRate, null);
  assert.equal(summarizeAttempts([]).averages.repairs, null);
});

test("comparisons preserve model comparability and mark provider mismatch", () => {
  for (const [before, after] of [
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const comparison = compareEvaluations(
      run,
      [attempt("a", before)],
      run,
      [attempt("a", after)],
    );
    assert.equal(comparison.overall.current.passRate, after ? 1 : 0);
  }
  const mismatch = compareEvaluations(run, [attempt("a", false)], { ...run, model: "other" }, [
    attempt("a", true),
  ]);
  assert.equal(mismatch.overall.delta, null);
  assert.equal(mismatch.scenarios[0]?.delta, null);
  assert.equal(mismatch.comparable, false);
  assert.equal(
    compareEvaluations(run, [attempt("a", false)], { ...run, provider: "groq" }, [
      attempt("a", true),
    ]).comparable,
    false,
  );
});

test("baseline validates, persists, and replaces across a store reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-baseline-test-"));
  const path = join(dir, "sessions.sqlite");
  let store = await SqliteSessionStore.open(path);
  try {
    assert.equal(store.evaluationBaseline(), undefined);
    assert.throws(() => store.setEvaluationBaseline("missing"), /not found/);
    const base = store.createEvaluationRun({ ...run });
    assert.throws(() => store.setEvaluationBaseline(base.id), /completed/);
    store.saveEvaluationAttempt({ ...attempt("a", true), runId: base.id });
    store.completeEvaluationRun(base.id);
    store.setEvaluationBaseline(base.id);
    const short = store.createEvaluationRun({ ...run, trialCount: 2 });
    store.saveEvaluationAttempt({ ...attempt("a", false), runId: short.id });
    store.completeEvaluationRun(short.id);
    assert.throws(() => store.setEvaluationBaseline(short.id), /three trials/);
    const wrongSuite = store.createEvaluationRun({ ...run });
    store.completeEvaluationRun(wrongSuite.id);
    const db = new Database(path);
    db.prepare("UPDATE evaluation_runs SET suite='other' WHERE id=?").run(wrongSuite.id);
    db.close();
    assert.throws(() => store.setEvaluationBaseline(wrongSuite.id), /self-evaluation/);
    assert.equal(store.evaluationBaseline()?.id, base.id);
    const replacement = store.createEvaluationRun({ ...run });
    store.completeEvaluationRun(replacement.id);
    store.setEvaluationBaseline(replacement.id);
    store.close();
    store = await SqliteSessionStore.open(path);
    assert.equal(store.evaluationBaseline()?.id, replacement.id);
    assert.equal(compareWithBaseline(store, base.id)?.baselineRun.id, replacement.id);
    assert.equal(compareWithBaseline(store, replacement.id)?.baselineRun.id, replacement.id);
    const shortComparison = compareWithBaseline(store, short.id);
    assert.equal(shortComparison?.baselineRun.id, replacement.id);
    assert.equal(shortComparison?.overall.baseline.attempts, 0);
    assert.equal(shortComparison?.overall.delta?.passRate, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
