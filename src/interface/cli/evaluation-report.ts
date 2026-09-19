import type {
  EvaluationResult,
  EvaluationAttempt,
  EvaluationRun,
  LiveEvaluationResult,
  SelfEvaluationResult,
} from "../../domain/models.js";
import type { JevEvaluationReport } from "../../application/evaluation-harness.js";

/** Reports matched deterministic Jev-off/Jev-on trials without changing evaluator semantics. */
export function formatJevEvaluationReport(report: JevEvaluationReport): string {
  const summarize = (results: EvaluationResult[]) => ({
    completed: results.filter((result) => result.passed).length,
    repairs: results.reduce((sum, result) => sum + result.metrics.repairs, 0),
    verificationFailures: results.reduce(
      (sum, result) => sum + result.metrics.verificationFailures,
      0,
    ),
    escalations: results.filter((result) => result.taskStatus === "verification_required").length,
    jevMs: results.reduce((sum, result) => sum + (result.metrics.jevMs ?? 0), 0),
    routes: results.reduce((sum, result) => sum + (result.metrics.jevRoutes ?? 0), 0),
    safety: results.reduce((sum, result) => sum + (result.metrics.jevSafetyChecks ?? 0), 0),
    recovery: results.reduce((sum, result) => sum + (result.metrics.jevRecoveryChecks ?? 0), 0),
  });
  const off = summarize(report.off);
  const on = summarize(report.on);
  return [
    "Kairo deterministic Jev evaluation (matched fixtures)",
    `Jev off: ${off.completed}/${report.off.length} verified completion; repairs=${off.repairs}; verification failures=${off.verificationFailures}; escalations=${off.escalations}`,
    `Jev on: ${on.completed}/${report.on.length} verified completion; repairs=${on.repairs}; verification failures=${on.verificationFailures}; escalations=${on.escalations}; Jev latency=${Math.round(on.jevMs)} ms; routing=${on.routes}; safety=${on.safety}; recovery=${on.recovery}`,
    "This deterministic mode measures integration behavior and metadata overhead, not live Jev decision quality.",
  ].join("\n");
}

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
        `verification=${result.metrics.focusedVerifications} focused/${result.metrics.broadVerifications} broad`,
        `repairConverged=${result.metrics.repairConverged}`,
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
        `retries=${result.metrics.providerRetries ?? "N/A"} waitMs=${result.metrics.providerWaitMs ?? "N/A"}`,
        result.failureCategory ? `failure=${result.failureCategory}` : "",
        `status=${result.taskStatus}`,
        `verified=${result.verified}`,
        `expectation=${result.expectationPassed}`,
        `turns=${result.metrics.modelTurns}`,
        `tools=${result.metrics.toolExecutions}`,
        `repairs=${result.metrics.repairs}`,
        `verification=${result.metrics.focusedVerifications} focused/${result.metrics.broadVerifications} broad`,
        `repairConverged=${result.metrics.repairConverged}`,
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
        `${run.id}  ${run.passedCount}/${run.attemptCount} passed  trials=${run.trialCount}  model=${run.provider}/${run.model}  revision=${run.sourceRevision}  ${new Date(run.startedAt).toISOString()}`,
    ),
  ].join("\n");
}

/** Renders one saved run without replaying sensitive task or model content. */
export function formatEvaluationRun(run: EvaluationRun, attempts: EvaluationAttempt[]): string {
  return [
    `Kairo self evaluation: ${run.id}`,
    `Reliability: ${run.passedCount}/${run.attemptCount} passed`,
    `Model: ${run.provider}/${run.model}  Revision: ${run.sourceRevision}  Trials: ${run.trialCount}`,
    `Started: ${new Date(run.startedAt).toISOString()}${run.completedAt ? `  Completed: ${new Date(run.completedAt).toISOString()}` : ""}`,
    ...attempts.map((attempt) =>
      [
        `${attempt.passed ? "PASS" : "FAIL"} ${attempt.scenarioId}`,
        `trial=${attempt.trial}`,
        `retries=${attempt.metrics.providerRetries ?? "N/A"} waitMs=${attempt.metrics.providerWaitMs ?? "N/A"}`,
        `status=${attempt.taskStatus}`,
        `verified=${attempt.verified}`,
        `expectation=${attempt.expectationPassed}`,
        `turns=${attempt.metrics.modelTurns}`,
        `tools=${attempt.metrics.toolExecutions}`,
        `repairs=${attempt.metrics.repairs}`,
        `verification=${attempt.metrics.focusedVerifications} focused/${attempt.metrics.broadVerifications} broad`,
        `repairConverged=${attempt.metrics.repairConverged}`,
        `durationMs=${attempt.durationMs}`,
        attempt.failureCategory ? `failure=${attempt.failureCategory}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    ),
  ].join("\n");
}
