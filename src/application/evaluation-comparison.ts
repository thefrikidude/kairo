import type { EvaluationAttempt, EvaluationRun } from "../domain/models.js";
import type { EvaluationStore } from "../domain/ports.js";

export const comparisonMetrics = [
  "modelTurns",
  "toolExecutions",
  "repairs",
  "verificationFailures",
  "durationMs",
] as const;
type Metric = (typeof comparisonMetrics)[number];
export interface ReliabilitySummary {
  attempts: number;
  passed: number;
  passRate: number | null;
  averages: Record<Metric, number | null>;
}
export interface ReliabilityChange {
  baseline: ReliabilitySummary;
  current: ReliabilitySummary;
  delta: ReliabilitySummary | null;
}
export interface EvaluationComparison {
  baselineRun: EvaluationRun;
  currentRun: EvaluationRun;
  comparable: boolean;
  overall: ReliabilityChange;
  scenarios: Array<ReliabilityChange & { scenarioId: string }>;
}

/** Averages observed attempts; missing data stays unavailable rather than becoming zero. */
export function summarizeAttempts(attempts: EvaluationAttempt[]): ReliabilitySummary {
  const passed = attempts.filter((attempt) => attempt.passed).length;
  const averages = Object.fromEntries(
    comparisonMetrics.map((metric) => {
      const values = attempts
        .map((attempt) => (metric === "durationMs" ? attempt.durationMs : attempt.metrics[metric]))
        .filter((value) => Number.isFinite(value));
      return [
        metric,
        values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      ];
    }),
  ) as ReliabilitySummary["averages"];
  return {
    attempts: attempts.length,
    passed,
    passRate: attempts.length ? passed / attempts.length : null,
    averages,
  };
}

/** Compares observed trial distributions, retaining missing scenarios on either side. */
export function compareEvaluations(
  baselineRun: EvaluationRun,
  baselineAttempts: EvaluationAttempt[],
  currentRun: EvaluationRun,
  currentAttempts: EvaluationAttempt[],
): EvaluationComparison {
  const comparable = baselineRun.model === currentRun.model;
  const difference = (before: number | null, after: number | null) =>
    before === null || after === null ? null : after - before;
  const change = (before: EvaluationAttempt[], after: EvaluationAttempt[]): ReliabilityChange => {
    const baseline = summarizeAttempts(before);
    const current = summarizeAttempts(after);
    return {
      baseline,
      current,
      delta: comparable
        ? {
            attempts: current.attempts - baseline.attempts,
            passed: current.passed - baseline.passed,
            passRate: difference(baseline.passRate, current.passRate),
            averages: Object.fromEntries(
              comparisonMetrics.map((metric) => [
                metric,
                difference(baseline.averages[metric], current.averages[metric]),
              ]),
            ) as ReliabilitySummary["averages"],
          }
        : null,
    };
  };
  const scenarios = [
    ...new Set([...baselineAttempts, ...currentAttempts].map((attempt) => attempt.scenarioId)),
  ].sort();
  return {
    baselineRun,
    currentRun,
    comparable,
    overall: change(baselineAttempts, currentAttempts),
    scenarios: scenarios.map((scenarioId) => ({
      scenarioId,
      ...change(
        baselineAttempts.filter((attempt) => attempt.scenarioId === scenarioId),
        currentAttempts.filter((attempt) => attempt.scenarioId === scenarioId),
      ),
    })),
  };
}

/** Loads a saved comparison; no baseline is a normal state for automatic reporting. */
export function compareWithBaseline(
  store: EvaluationStore,
  runId: string,
): EvaluationComparison | undefined {
  const current = store.evaluationRun(runId);
  if (!current) throw new Error(`Evaluation run not found: ${runId}`);
  if (current.suite !== "self" || current.completedAt === undefined)
    throw new Error("Comparison requires a completed self-evaluation run.");
  const baseline = store.evaluationBaseline();
  return (
    baseline &&
    compareEvaluations(
      baseline,
      store.evaluationAttempts(baseline.id),
      current,
      store.evaluationAttempts(current.id),
    )
  );
}
