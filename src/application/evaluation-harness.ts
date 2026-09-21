import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationResult, Message, ModelTurn, ToolCall } from "../domain/models.js";
import type { ApprovalPolicy, JevSafetyAdvisor, ModelProvider } from "../domain/ports.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { RepositoryProfiler } from "../infrastructure/repository/repository-profiler.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";

export type EvaluationScenario = {
  id: string;
  prompt: string;
  steps: ModelTurn[];
  expect(workspace: string): Promise<boolean>;
};

const fixtures = join(process.cwd(), "evals", "fixtures");

/** Supplies fixed model decisions so the first benchmark measures agent mechanics reproducibly. */
class ScenarioProvider implements ModelProvider {
  private index = 0;
  constructor(private readonly steps: ModelTurn[]) {}
  /** Returns the next deterministic model decision for this benchmark case. */
  async stream(_messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn> {
    const step = this.steps[this.index++];
    if (!step) return { text: "Scenario finished.", toolCalls: [] };
    if (step.text) onText(step.text);
    return step;
  }
}

/** Eval runs operate only in a disposable fixture copy, so approvals are deterministic and isolated. */
class FixtureApproval implements ApprovalPolicy {
  /** Approves only actions inside the disposable fixture copy created by this harness. */
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}

export const evaluationScenarios: EvaluationScenario[] = [
  {
    id: "create-file",
    prompt: "Create result.txt containing done and verify the project tests.",
    steps: [
      {
        text: "",
        toolCalls: [
          { id: "write", name: "write_file", args: { path: "result.txt", content: "done\n" } },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "test",
            name: "run_command",
            args: { command: "node --test test.mjs", verification: true },
          },
        ],
      },
      { text: "Created and verified.", toolCalls: [] },
    ],
    async expect(workspace) {
      return (await readFile(join(workspace, "result.txt"), "utf8")) === "done\n";
    },
  },
  {
    id: "repair-failing-test",
    prompt: "Fix the failing message test and verify it.",
    steps: [
      {
        text: "",
        toolCalls: [
          {
            id: "first-edit",
            name: "edit_file",
            args: { path: "message.txt", oldText: "bad\n", newText: "still-bad\n" },
          },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "first-test",
            name: "run_command",
            args: { command: "node --test test.mjs", verification: true },
          },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "fix",
            name: "edit_file",
            args: { path: "message.txt", oldText: "still-bad\n", newText: "good\n" },
          },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "second-test",
            name: "run_command",
            args: { command: "node --test test.mjs", verification: true },
          },
        ],
      },
      { text: "Fixed and verified.", toolCalls: [] },
    ],
    async expect(workspace) {
      return (await readFile(join(workspace, "message.txt"), "utf8")) === "good\n";
    },
  },
];

/** Runs all fixture cases in disposable copies and returns only the final aggregate evidence. */
export async function runEvaluationSuite(): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  for (const scenario of evaluationScenarios) results.push(await runScenario(scenario));
  return results;
}

export type JevEvaluationReport = {
  off: EvaluationResult[];
  on: EvaluationResult[];
};

/** Runs matched deterministic fixtures to isolate Jev decision overhead from model quality. */
export async function runJevEvaluationSuite(): Promise<JevEvaluationReport> {
  const advisor: JevSafetyAdvisor = {
    async assess() {
      return { risk: "low", confidence: 1 };
    },
    async route() {
      return { value: "build", confidence: 1 };
    },
    async recover() {
      return { value: "repair", confidence: 1 };
    },
    async modelTier() {
      return { value: "balanced", confidence: 1 };
    },
  };
  return {
    off: await runEvaluationSuite(),
    on: await Promise.all(evaluationScenarios.map((scenario) => runScenario(scenario, advisor))),
  };
}

/** Runs one scenario with isolated storage so benchmark state cannot affect the user workspace. */
export async function runScenario(
  scenario: EvaluationScenario,
  jev?: JevSafetyAdvisor,
): Promise<EvaluationResult> {
  const root = await mkdtemp(join(tmpdir(), `kairo-eval-${scenario.id}-`));
  try {
    await cp(join(fixtures, scenario.id), root, { recursive: true });
    const store = await SqliteSessionStore.open(":memory:");
    try {
      const session = store.create(root);
      const tools = await WorkspaceTools.create(root);
      store.saveRepositorySnapshot(session.id, await new RepositoryProfiler().profile(root));
      const agent = new CodingAgent(
        new ScenarioProvider(scenario.steps),
        store,
        tools,
        new FixtureApproval(),
        definitions,
        undefined,
        jev,
      );
      await agent.run(session.id, scenario.prompt, () => {});
      const task = agent.status(session.id)!;
      const expectationPassed = await scenario.expect(root);
      const metrics = taskMetrics(store.taskEvents(task.id));
      const verified = task.verificationPassed === true;
      return {
        id: scenario.id,
        passed: task.status === "completed" && verified && expectationPassed,
        taskStatus: task.status,
        verified,
        expectationPassed,
        metrics: {
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
          jevDecisions: metrics.jevDecisions,
          jevFailures: metrics.jevFailures,
          jevMs: metrics.jevMs,
          jevRoutes: metrics.jevRoutes,
          jevSafetyChecks: metrics.jevSafetyChecks,
          jevRecoveryChecks: metrics.jevRecoveryChecks,
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
      metrics: {
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
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
