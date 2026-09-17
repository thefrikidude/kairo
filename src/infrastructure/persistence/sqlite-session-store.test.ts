import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import type { RepositoryProfile } from "../../domain/models.js";

test("sessions persist messages and sort by latest activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-store-"));
  const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  store.addMessage(session.id, { role: "user", content: "hello", createdAt: 1 });
  assert.equal(store.get(session.id)?.workspace, "/workspace");
  assert.deepEqual(
    store.messages(session.id).map((item) => item.content),
    ["hello"],
  );
  assert.equal(store.list()[0]?.id, session.id);
  store.close();
});

test("active tasks recover as interrupted after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-recover-"));
  const path = join(dir, "sessions.sqlite");
  const first = await SqliteSessionStore.open(path);
  const session = first.create("/workspace");
  const task = first.startTask(session.id, "repair tests");
  first.updateTask(task.id, { status: "acting" });
  first.close();
  const restarted = await SqliteSessionStore.open(path);
  assert.equal(restarted.task(task.id)?.status, "interrupted");
  restarted.close();
});

test("saved planning artifacts survive a store restart and remain discoverable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-plan-store-"));
  const path = join(dir, "sessions.sqlite");
  const first = await SqliteSessionStore.open(path);
  const session = first.create("/workspace");
  const task = first.startTask(session.id, "plan task support", "planning");
  first.updateTask(task.id, {
    status: "planned",
    plan: {
      goal: "Plan task support",
      assumptions: [],
      files: [{ path: "src/application/coding-agent.ts", reason: "Add planning coordination." }],
      steps: ["Persist plans."],
      verification: { reason: "No execution occurs in planning mode." },
      risks: [],
    },
  });
  first.close();
  const restarted = await SqliteSessionStore.open(path);
  try {
    assert.equal(restarted.latestPlan(session.id)?.id, task.id);
    assert.equal(restarted.task(task.id)?.plan?.verification.command, undefined);
  } finally {
    restarted.close();
  }
});

test("repository profiles persist for resumed sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-profile-store-"));
  const path = join(dir, "sessions.sqlite");
  const profile: RepositoryProfile = {
    root: "/workspace",
    packageManager: "pnpm",
    scripts: { test: "node --test" },
    configFiles: ["tsconfig.json"],
    sourceRoots: ["src"],
    testRoots: ["test"],
    ignoredPaths: ["node_modules"],
    indexedFiles: ["src/index.ts"],
    files: [],
    verificationCandidates: [{ label: "test", command: "pnpm test" }],
    createdAt: 1,
  };
  const first = await SqliteSessionStore.open(path);
  const session = first.create("/workspace");
  first.saveRepositoryProfile(session.id, profile);
  first.close();
  const restarted = await SqliteSessionStore.open(path);
  assert.deepEqual(restarted.repositoryProfile(session.id), profile);
  restarted.close();
});

test("repair attempts persist failure evidence for an interrupted task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-repair-store-"));
  const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  const task = store.startTask(session.id, "repair login");
  store.recordRepairAttempt({
    id: "repair-1",
    taskId: task.id,
    command: "pnpm test",
    evidence: {
      summary: "FAIL tests/login.test.ts",
      fileLocations: [{ path: "tests/login.test.ts", line: 8 }],
      excerpts: ["Expected false"],
    },
    selectedFiles: ["tests/login.test.ts"],
    createdAt: 1,
  });
  assert.deepEqual(store.repairAttempts(task.id)[0]?.selectedFiles, ["tests/login.test.ts"]);
  store.close();
});

test("evaluation history persists sanitized attempts and calculates aggregates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-evaluation-store-"));
  const path = join(dir, "sessions.sqlite");
  const store = await SqliteSessionStore.open(path);
  const run = store.createEvaluationRun({
    suite: "self",
    provider: "gemini",
    model: "gemini-test",
    sourceRevision: "abc123",
    trialCount: 1,
    startedAt: 10,
    completedAt: undefined,
  });
  store.saveEvaluationAttempt({
    runId: run.id,
    scenarioId: "safe-read",
    trial: 1,
    passed: true,
    taskStatus: "completed",
    verified: true,
    expectationPassed: true,
    metrics: {
      modelTurns: 2,
      toolExecutions: 3,
      toolFailures: 0,
      approvals: 2,
      repairs: 0,
      verificationPasses: 1,
      verificationFailures: 0,
      verificationSelections: 1,
      focusedVerifications: 1,
      broadVerifications: 0,
      repairConverged: false,
      modelMs: 4,
      toolMs: 5,
    },
    durationMs: 20,
    createdAt: 11,
  });
  store.saveEvaluationAttempt({
    runId: run.id,
    scenarioId: "repair-brief",
    trial: 1,
    passed: false,
    taskStatus: "failed",
    verified: false,
    expectationPassed: false,
    failureCategory: "verification",
    metrics: {
      modelTurns: 1,
      toolExecutions: 1,
      toolFailures: 1,
      approvals: 1,
      repairs: 0,
      verificationPasses: 0,
      verificationFailures: 1,
      verificationSelections: 1,
      focusedVerifications: 0,
      broadVerifications: 1,
      repairConverged: false,
      modelMs: 2,
      toolMs: 3,
    },
    durationMs: 21,
    createdAt: 12,
  });
  assert.equal(store.completeEvaluationRun(run.id).passedCount, 1);
  assert.equal(store.evaluationRun(run.id)?.attemptCount, 2);
  assert.deepEqual(
    store.evaluationAttempts(run.id).map((attempt) => attempt.scenarioId),
    ["safe-read", "repair-brief"],
  );
  assert.equal(
    JSON.stringify(store.evaluationAttempts(run.id)).includes("raw secret output"),
    false,
  );
  store.close();
  const reopened = await SqliteSessionStore.open(path);
  assert.equal(reopened.evaluationRuns()[0]?.id, run.id);
  reopened.close();
});

test("legacy evaluation runs migrate to the Gemini provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-evaluation-migration-"));
  const path = join(dir, "sessions.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE evaluation_runs (
    id TEXT PRIMARY KEY, suite TEXT NOT NULL, model TEXT NOT NULL,
    source_revision TEXT NOT NULL, trial_count INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL, passed_count INTEGER NOT NULL,
    started_at INTEGER NOT NULL, completed_at INTEGER
  )`);
  legacy
    .prepare("INSERT INTO evaluation_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy", "self", "gemini-old", "abc", 1, 0, 0, 1, 2);
  legacy.close();
  const store = await SqliteSessionStore.open(path);
  try {
    assert.equal(store.evaluationRun("legacy")?.provider, "gemini");
  } finally {
    store.close();
  }
});
