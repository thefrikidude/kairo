import type {
  EvaluationResult,
  EvaluationAttempt,
  EvaluationRun,
  LiveEvaluationResult,
  SelfEvaluationResult,
} from "../../domain/models.js";

/** Renders benchmark evidence in a compact human-readable report. */
export function formatEvaluationReport(results: EvaluationResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  return [
    `Kairo scripted evaluation: ${passed}/${results.length} passed`,
    ...results.map((result) =>
      [
        `${result.passed ? "PASS" : "FAIL"} ${result.id}`,
        `status=${result.taskStatus}`,
        `verified=${result.verified}`,
        `expectation=${result.expectationPassed}`,
        `turns=${result.metrics.modelTurns}`,
        `tools=${result.metrics.toolExecutions}`,
        `repairs=${result.metrics.repairs}`,
        `checks=${result.metrics.verificationPasses}/${result.metrics.verificationFailures}`,
        result.error ? `error=${result.error}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}

/** Renders deterministic task evidence and DeepEval's semantic completion verdict side by side. */
export function formatLiveEvaluationReport(results: LiveEvaluationResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  return [
    `Kairo live DeepEval evaluation: ${passed}/${results.length} passed`,
    ...results.map((result) =>
      [
        `${result.passed ? "PASS" : "FAIL"} ${result.id}`,
        `status=${result.taskStatus}`,
        `verified=${result.verified}`,
        `expectation=${result.expectationPassed}`,
        `judge=${result.judge.passed ? "passed" : "failed"}`,
        result.judge.score === undefined ? "" : `score=${result.judge.score.toFixed(2)}`,
        result.judge.reason ? `reason=${result.judge.reason}` : "",
        result.judge.error ? `judgeError=${result.judge.error}` : "",
        result.error ? `error=${result.error}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}

/** Renders real Kairo repository tasks, including trial identity for stochastic agent runs. */
export function formatSelfEvaluationReport(
  results: SelfEvaluationResult[],
  runId?: string,
): string {
  const passed = results.filter((result) => result.passed).length;
  return [
    `Kairo self evaluation${runId ? ` (${runId})` : ""}: ${passed}/${results.length} passed`,
    ...results.map((result) =>
      [
        `${result.passed ? "PASS" : "FAIL"} ${result.id}`,
        `trial=${result.trial}`,
        `status=${result.taskStatus}`,
        `verified=${result.verified}`,
        `expectation=${result.expectationPassed}`,
        `turns=${result.metrics.modelTurns}`,
        `tools=${result.metrics.toolExecutions}`,
        `repairs=${result.metrics.repairs}`,
        result.error ? `error=${result.error}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}

/** Renders compact metadata-only reliability history for baseline comparisons. */
export function formatEvaluationHistory(runs: EvaluationRun[]): string {
  if (!runs.length) return "No saved self-evaluation runs.";
  return [
    "Kairo self-evaluation history:",
    ...runs.map(
      (run) =>
        `${run.id}  ${run.passedCount}/${run.attemptCount} passed  trials=${run.trialCount}  model=${run.model}  revision=${run.sourceRevision}  ${new Date(run.startedAt).toISOString()}`,
    ),
  ].join("\n");
}

/** Renders one saved run without replaying sensitive task or model content. */
export function formatEvaluationRun(run: EvaluationRun, attempts: EvaluationAttempt[]): string {
  return [
    `Kairo self evaluation: ${run.id}`,
    `Reliability: ${run.passedCount}/${run.attemptCount} passed`,
    `Model: ${run.model}  Revision: ${run.sourceRevision}  Trials: ${run.trialCount}`,
    `Started: ${new Date(run.startedAt).toISOString()}${run.completedAt ? `  Completed: ${new Date(run.completedAt).toISOString()}` : ""}`,
    ...attempts.map((attempt) =>
      [
        `${attempt.passed ? "PASS" : "FAIL"} ${attempt.scenarioId}`,
        `trial=${attempt.trial}`,
        `status=${attempt.taskStatus}`,
        `verified=${attempt.verified}`,
        `expectation=${attempt.expectationPassed}`,
        `turns=${attempt.metrics.modelTurns}`,
        `tools=${attempt.metrics.toolExecutions}`,
        `repairs=${attempt.metrics.repairs}`,
        `durationMs=${attempt.durationMs}`,
        attempt.failureCategory ? `failure=${attempt.failureCategory}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}
