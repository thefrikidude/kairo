import type { Task, TaskEvent, TaskPlan } from "../../domain/models.js";
import { taskMetrics } from "../../application/task-metrics.js";

/** Formats durable counters; legacy tasks explicitly report unavailable instrumentation. */
export function formatMetrics(events: TaskEvent[]): string {
  if (!events.length)
    return "No trace recorded for this task (created before tracing was enabled).";
  const m = taskMetrics(events);
  return [
    `Provider retries: ${m.providerRetries}; retry waiting: ${Math.round(m.providerWaitMs)} ms`,
    `Model: ${m.modelTurns} turns, ${m.modelFailures} failures, ${Math.round(m.modelMs)} ms`,
    `Tools: ${m.toolRequests} requests, ${m.toolExecutions} executed, ${m.toolFailures} failures, ${Math.round(m.toolMs)} ms`,
    `Approvals: ${m.approvals} allowed, ${m.denials} denied, ${m.autonomousActions} Jev-autonomous, ${Math.round(m.approvalMs)} ms waiting`,
    `Repairs: ${m.repairs}${m.repairConverged ? " (converged)" : ""}; command checks: ${m.verificationPasses} passed, ${m.verificationFailures} failed`,
    `Verification selection: ${m.focusedVerifications} focused, ${m.broadVerifications} broad (${m.verificationSelections} total)`,
    `Jev: ${m.jevDecisions} decisions (${m.jevRoutes} routing, ${m.jevSafetyChecks} safety, ${m.jevRecoveryChecks} recovery), ${m.jevFailures} fallbacks, ${Math.round(m.jevMs)} ms`,
    `Unfinished operations: ${m.unfinishedOperations}`,
  ].join("\n");
}

/** Shows the latest 100 events in execution order without rendering untrusted command output. */
export function formatTrace(task: Task, events: TaskEvent[]): string {
  return [
    `Task ${task.id}: ${task.status}`,
    formatMetrics(events),
    ...(events.length > 100 ? ["Showing latest 100 events."] : []),
    ...events
      .slice(-100)
      .map((event) =>
        [
          new Date(event.createdAt).toISOString(),
          event.kind,
          event.name?.replace(/[\x00-\x1f\x7f-\x9f]/g, ""),
          event.outcome,
          event.durationMs === undefined ? "" : `${Math.round(event.durationMs)} ms`,
          event.exitCode === undefined ? "" : `exit=${event.exitCode}`,
        ]
          .filter(Boolean)
          .join("  "),
      ),
  ].join("\n");
}

/** Renders the saved plan as a compact terminal artifact for review. */
export function formatPlan(plan: TaskPlan): string {
  return [
    `Goal: ${plan.goal}`,
    `Assumptions: ${plan.assumptions.length ? plan.assumptions.map((item) => `- ${item}`).join("\n") : "none"}`,
    `Files:\n${plan.files.length ? plan.files.map((file) => `- ${file.path}: ${file.reason}`).join("\n") : "- No files identified."}`,
    `Steps:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    `Verification: ${plan.verification.command ? `\`${plan.verification.command}\` — ` : "No command selected — "}${plan.verification.reason}`,
    `Risks: ${plan.risks.length ? plan.risks.map((item) => `- ${item}`).join("\n") : "none"}`,
  ].join("\n\n");
}
