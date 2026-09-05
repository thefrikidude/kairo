import type { EvaluationResult } from "../../domain/models.js";

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
