import type { Task, TaskEvent } from "../../domain/models.js";
import { taskMetrics } from "../../application/task-metrics.js";

/** Formats durable counters; legacy tasks explicitly report unavailable instrumentation. */
export function formatMetrics(events: TaskEvent[]): string {
  if (!events.length)
    return "No trace recorded for this task (created before tracing was enabled).";
  const m = taskMetrics(events);
  return [
    `Model: ${m.modelTurns} turns, ${m.modelFailures} failures, ${Math.round(m.modelMs)} ms`,
    `Tools: ${m.toolRequests} requests, ${m.toolExecutions} executed, ${m.toolFailures} failures, ${Math.round(m.toolMs)} ms`,
    `Approvals: ${m.approvals} allowed, ${m.denials} denied, ${Math.round(m.approvalMs)} ms waiting`,
    `Repairs: ${m.repairs}; command checks: ${m.verificationPasses} passed, ${m.verificationFailures} failed`,
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
