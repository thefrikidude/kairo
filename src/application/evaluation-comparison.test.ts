import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import {
  compareEvaluations,
  compareWithBaseline,
  summarizeAttempts,
} from "./evaluation-comparison.js";
import { formatComparison } from "../interface/cli/evaluation-comparison-report.js";
import type { EvaluationAttempt, EvaluationRun } from "../domain/models.js";

const run: EvaluationRun = {
  id: "base",
  suite: "self",
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

test("reports improvements, regressions, no change, and model mismatch without deltas", () => {
  for (const [before, after, expected] of [
    [false, true, "IMPROVEMENT"],
    [true, false, "REGRESSION"],
    [true, true, "NO CHANGE"],
  ] as const) {
    assert.match(
      formatComparison(compareEvaluations(run, [attempt("a", before)], run, [attempt("a", after)])),
      new RegExp(expected),
    );
  }
  const mismatch = compareEvaluations(run, [attempt("a", false)], { ...run, model: "other" }, [
    attempt("a", true),
  ]);
  assert.equal(mismatch.overall.delta, null);
  assert.equal(mismatch.scenarios[0]?.delta, null);
  assert.match(formatComparison(mismatch), /not directly comparable/);
  assert.doesNotMatch(formatComparison(mismatch), /IMPROVEMENT|REGRESSION/);
});

test("baseline validates, persists, replaces, and CLI commands resolve local state", async () => {
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
    const cli = async (...args: string[]) =>
      (
        await promisify(execFile)(
          process.execPath,
          ["dist/interface/cli/index.js", "eval", ...args],
          { cwd: process.cwd(), env: { ...process.env, KAIRO_STATE_DIR: dir } },
        )
      ).stdout;
    assert.match(await cli("baseline", "show"), new RegExp(replacement.id));
    assert.match(await cli("baseline", "set", base.id), new RegExp(base.id));
    assert.match(await cli("compare", replacement.id), /N\/A/);
    assert.match(await cli("compare", short.id), /REGRESSION/);
    const json = JSON.parse(await cli("compare", base.id, "--json"));
    assert.equal(json.comparable, true);
    assert.equal(json.overall.delta.passRate, 0);
    await assert.rejects(cli("baseline", "set", "missing"));
    await assert.rejects(cli("compare"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
