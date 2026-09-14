import {
  comparisonMetrics,
  summarizeAttempts,
  type EvaluationComparison,
  type ReliabilityChange,
} from "../../application/evaluation-comparison.js";
import type { EvaluationAttempt, EvaluationRun } from "../../domain/models.js";

/** Formats missing observations explicitly. */
function rate(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}
/** Labels directional changes without implying statistical significance. */
function delta(value: number | null, higherIsBetter: boolean, suffix = ""): string {
  if (value === null) return "N/A (missing attempts)";
  const label =
    Math.abs(value) < 1e-9
      ? "NO CHANGE"
      : value > 0 === higherIsBetter
        ? "IMPROVEMENT"
        : "REGRESSION";
  return `${label} ${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}
/** Shows both observed denominators and, when compatible, their deltas. */
function changeLines(label: string, change: ReliabilityChange): string[] {
  const { baseline: b, current: c, delta: d } = change;
  return [
    `Infrastructure failures: ${b.infrastructureFailures} -> ${c.infrastructureFailures}; coding attempts: ${b.codingAttempts} -> ${c.codingAttempts}; coding-outcome pass rate: ${rate(b.codingPassRate)} -> ${rate(c.codingPassRate)}${d ? ` | ${delta(d.codingPassRate === null ? null : d.codingPassRate * 100, true, " pp")}` : ""}`,
    `${label}: ${b.passed}/${b.attempts} (${rate(b.passRate)}) -> ${c.passed}/${c.attempts} (${rate(c.passRate)})${d ? ` | ${delta(d.passRate === null ? null : d.passRate * 100, true, " pp")}; passed-attempt change ${d.passed > 0 ? "+" : ""}${d.passed}` : ""}`,
    ...comparisonMetrics.map(
      (metric) =>
        `  avg ${metric}: ${b.averages[metric]?.toFixed(2) ?? "N/A"} -> ${c.averages[metric]?.toFixed(2) ?? "N/A"}${d ? ` | ${delta(d.averages[metric], false)}` : ""}`,
    ),
  ];
}
/** Displays the selected baseline without including any agent content. */
export function formatBaseline(run: EvaluationRun, attempts: EvaluationAttempt[]): string {
  const summary = summarizeAttempts(attempts);
  return `Self-evaluation baseline: ${run.id}\nModel: ${run.provider}/${run.model}  Revision: ${run.sourceRevision}  Trials: ${run.trialCount}\nReliability: ${summary.passed}/${summary.attempts} passed (${rate(summary.passRate)})`;
}
/** Renders informational aggregate and per-scenario reliability changes. */
export function formatComparison(comparison: EvaluationComparison): string {
  const { baselineRun: b, currentRun: c } = comparison;
  return [
    "Self-evaluation baseline comparison (informational):",
    `Baseline: ${b.id}  model=${b.provider}/${b.model}  revision=${b.sourceRevision}  trials=${b.trialCount}`,
    `Current: ${c.id}  model=${c.provider}/${c.model}  revision=${c.sourceRevision}  trials=${c.trialCount}`,
    ...(!comparison.comparable
      ? ["Provider/model mismatch: runs are not directly comparable; deltas are omitted."]
      : []),
    "Rates and averages use observed attempts; absent attempts are not counted as failures. Lower resource averages do not establish better correctness.",
    "Coding-outcome rates exclude classified infrastructure failures. Historical misclassifications cannot be reconstructed from saved metadata.",
    ...changeLines("Overall", comparison.overall),
    ...comparison.scenarios.flatMap((scenario) => changeLines(scenario.scenarioId, scenario)),
  ].join("\n");
}
