import type { TaskEvent } from "../domain/models.js";

/** Derives counters from durable events so resume never resets or doubles stored totals. */
export function taskMetrics(events: TaskEvent[]) {
  const count = (kind: TaskEvent["kind"], outcome?: string) =>
    events.filter((event) => event.kind === kind && (!outcome || event.outcome === outcome)).length;
  const duration = (kind: TaskEvent["kind"]) =>
    events
      .filter((event) => event.kind === kind)
      .reduce((sum, event) => sum + (event.durationMs ?? 0), 0);
  const started = events.filter(
    (event) => event.kind === "model_started" || event.kind === "tool_started",
  );
  const unfinished = started.filter(
    (event) =>
      !events.some(
        (end) =>
          end.operationId === event.operationId &&
          end.kind === (event.kind === "model_started" ? "model_finished" : "tool_finished"),
      ),
  );
  return {
    modelTurns: count("model_started"),
    modelFailures: count("model_finished", "failed"),
    modelMs: duration("model_finished"),
    toolRequests: count("tool_requested"),
    toolExecutions: count("tool_started"),
    toolFailures: count("tool_finished", "failed"),
    toolMs: duration("tool_finished"),
    approvals: count("approval", "approved"),
    denials: count("approval", "denied"),
    approvalMs: duration("approval"),
    repairs: count("repair"),
    verificationPasses: count("verification", "passed"),
    verificationFailures: count("verification", "failed"),
    unfinishedOperations: unfinished.length,
  };
}
