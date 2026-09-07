import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationDataset, Golden } from "deepeval/dataset";
import { TaskCompletionMetric } from "deepeval/metrics";
import { GeminiModel } from "deepeval/models";
import { SpanType, observe, updateCurrentSpan } from "deepeval/tracing";
import type { LiveEvaluationResult, Message, ToolCall } from "../domain/models.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { GeminiProvider } from "../infrastructure/providers/gemini-provider.js";
import { RepositoryProfiler } from "../infrastructure/repository/repository-profiler.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import { CodingAgent } from "./coding-agent.js";
import { evaluationScenarios, type EvaluationScenario } from "./evaluation-harness.js";
import { taskMetrics } from "./task-metrics.js";
import { runEvaluatedAgent } from "./evaluated-agent.js";

const fixtures = join(process.cwd(), "evals", "fixtures");

export type LiveEvaluationOptions = {
  onProgress?: (text: string) => void;
  apiKey: string;
  model: string;
};

/** Evaluates live Gemini runs in disposable fixtures; DeepEval scores behavior, not the fixture assertion. */
export async function runLiveEvaluationSuite(
  options: LiveEvaluationOptions,
): Promise<LiveEvaluationResult[]> {
  const dataset = new EvaluationDataset({
    goldens: evaluationScenarios.map(
      (scenario) =>
        new Golden({
          name: scenario.id,
          input: scenario.prompt,
          expectedOutput: expectedOutcome(scenario),
        }),
    ),
  });
  const completion = new TaskCompletionMetric({
    model: new GeminiModel({ apiKey: options.apiKey, model: options.model }),
    threshold: 0.7,
    includeReason: true,
  });
  const results: LiveEvaluationResult[] = [];
  let scenarioIndex = 0;

  for await (const golden of dataset.evalsIterator({
    metrics: [completion],
    errorConfig: { ignoreErrors: true },
    displayConfig: { printResults: false, showIndicator: false },
    identifier: "kairo-live",
  })) {
    const scenario = evaluationScenarios[scenarioIndex++];
    if (!(golden instanceof Golden))
      throw new Error("Live coding evaluations require single-turn goldens.");
    const deterministic = await runObservedScenario(scenario, golden.input, options);
    results.push(deterministic);
  }

  return results.map((result, index) => {
    const metric = dataset.evalResults[index]?.metricsData?.find(
      (item) => item.name === "Task Completion",
    );
    const judge = {
      passed: metric?.success === true,
      score: metric?.score,
      reason: metric?.reason,
      error: metric?.error,
    };
    return { ...result, passed: result.passed && judge.passed, judge };
  });
}

/** Runs one actual agent task under a DeepEval agent span, keeping raw workspace data out of the trace. */
async function runObservedScenario(
  scenario: EvaluationScenario,
  prompt: string,
  options: LiveEvaluationOptions,
): Promise<LiveEvaluationResult> {
  const root = await mkdtemp(join(tmpdir(), `kairo-live-eval-${scenario.id}-`));
  try {
    await cp(join(fixtures, scenario.id), root, { recursive: true });
    const store = await SqliteSessionStore.open(":memory:");
    try {
      const session = store.create(root);
      const tools = await WorkspaceTools.create(root);
      store.saveRepositoryProfile(session.id, await new RepositoryProfiler().profile(root));
      const agent = new CodingAgent(
        new GeminiProvider(options.apiKey, options.model, definitions),
        store,
        tools,
        new FixtureApproval(),
        definitions,
      );
      let failure: Awaited<ReturnType<typeof runEvaluatedAgent>> = {};
      const runAgent = observe({
        type: SpanType.AGENT,
        name: "kairo-coding-agent",
        availableTools: definitions.map((definition) => definition.name),
        fn: async (input: string): Promise<string> => {
          failure = await runEvaluatedAgent(agent, session.id, input, options.onProgress);
          const task = agent.status(session.id)!;
          const output = finalResponse(store.messages(session.id), task.error);
          const events = store.taskEvents(task.id);
          updateCurrentSpan({
            input,
            output,
            expectedOutput: expectedOutcome(scenario),
            toolsCalled: toolCalls(events),
            metadata: {
              taskStatus: task.status,
              changedFileCount: task.changedFiles.length,
              verificationPassed: task.verificationPassed === true,
              repairAttempts: store.repairAttempts(task.id).length,
            },
          });
          return output;
        },
      });
      await runAgent(prompt);
      const task = agent.status(session.id)!;
      const expectationPassed = failure.error ? false : await scenario.expect(root);
      const metrics = taskMetrics(store.taskEvents(task.id));
      const verified = task.verificationPassed === true;
      return {
        id: scenario.id,
        passed: task.status === "completed" && verified && expectationPassed,
        taskStatus: task.status,
        verified,
        expectationPassed,
        error: failure.error ?? task.error,
        failureCategory: failure.category,
        judge: { passed: false },
        metrics: {
          providerRetries: metrics.providerRetries,
          providerWaitMs: metrics.providerWaitMs,
          modelTurns: metrics.modelTurns,
          toolExecutions: metrics.toolExecutions,
          toolFailures: metrics.toolFailures,
          approvals: metrics.approvals,
          repairs: metrics.repairs,
          verificationPasses: metrics.verificationPasses,
          verificationFailures: metrics.verificationFailures,
          verificationSelections: metrics.verificationSelections,
          focusedVerifications: metrics.focusedVerifications,
          broadVerifications: metrics.broadVerifications,
          repairConverged: metrics.repairConverged,
          modelMs: metrics.modelMs,
          toolMs: metrics.toolMs,
        },
      };
    } finally {
      store.close();
    }
  } catch (error) {
    return {
      id: scenario.id,
      passed: false,
      taskStatus: "failed",
      verified: false,
      expectationPassed: false,
      error: (error as Error).message,
      judge: { passed: false },
      metrics: emptyMetrics(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Eval fixture mutations are intentionally pre-approved, unlike an interactive user workspace. */
class FixtureApproval {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}

/** The final natural-language model message is useful judge context without exposing tool output. */
function finalResponse(messages: Message[], error: string | undefined): string {
  return (
    [...messages].reverse().find((message) => message.role === "model" && !message.toolCallId)
      ?.content ??
    error ??
    "Agent finished without a final response."
  );
}

/** Tool names retain the agent trajectory shape while withholding paths, arguments, and command output. */
function toolCalls(events: Array<{ kind: string; name?: string }>): Array<{ name: string }> {
  return events
    .filter((event) => event.kind === "tool_requested" && event.name)
    .map((event) => ({ name: event.name! }));
}

function expectedOutcome(scenario: EvaluationScenario): string {
  return scenario.id === "create-file"
    ? "Create result.txt containing done and run the fixture test successfully."
    : "Repair message.txt so the fixture test passes after the initial failure.";
}

function emptyMetrics(): LiveEvaluationResult["metrics"] {
  return {
    modelTurns: 0,
    toolExecutions: 0,
    toolFailures: 0,
    approvals: 0,
    repairs: 0,
    verificationPasses: 0,
    verificationFailures: 0,
    verificationSelections: 0,
    focusedVerifications: 0,
    broadVerifications: 0,
    repairConverged: false,
    modelMs: 0,
    toolMs: 0,
  };
}
