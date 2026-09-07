import type {
  EvaluationResult,
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
export function formatSelfEvaluationReport(results: SelfEvaluationResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  return [
    `Kairo self evaluation: ${passed}/${results.length} passed`,
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
