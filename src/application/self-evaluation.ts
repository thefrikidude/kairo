import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SelfEvaluationResult, ToolCall } from "../domain/models.js";
import type { ApprovalPolicy } from "../domain/ports.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { GeminiProvider } from "../infrastructure/providers/gemini-provider.js";
import { RepositoryProfiler } from "../infrastructure/repository/repository-profiler.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";

type SelfEvaluationScenario = {
  id: string;
  prompt: string;
  seed(workspace: string): Promise<void>;
  grade(workspace: string): Promise<void>;
};

export type SelfEvaluationOptions = {
  apiKey: string;
  model: string;
  trials?: number;
  sourceRoot?: string;
};

const replacement = async (
  workspace: string,
  path: string,
  before: string,
  after: string,
): Promise<void> => {
  const target = join(workspace, path);
  const source = await readFile(target, "utf8");
  if (!source.includes(before)) throw new Error(`Self-eval seed no longer matches ${path}.`);
  await writeFile(target, source.replace(before, after), "utf8");
};

const scenarios: SelfEvaluationScenario[] = [
  {
    id: "verification-check-script",
    prompt:
      "A JavaScript project with only a `check` package script is not offered a typecheck verification command. Fix verification discovery so the `check` script is recognized as typecheck, preserve the existing command format for each package manager, add or update a focused test, and run the relevant verification.",
    async seed(workspace) {
      await replacement(
        workspace,
        "src/application/verification-planner.ts",
        '["typecheck", ["typecheck", "type-check", "check"]]',
        '["typecheck", ["typecheck", "type-check"]]',
      );
    },
    async grade(workspace) {
      await assertCommand(workspace, ["test"]);
      const module = await import(
        pathToFileURL(join(workspace, "dist/application/verification-planner.js")).href
      );
      const candidates = new module.VerificationPlanner().candidates({
        packageManager: "pnpm",
        scripts: { check: "tsc --noEmit" },
      });
      if (
        JSON.stringify(candidates) !==
        JSON.stringify([{ label: "typecheck", command: "pnpm check" }])
      )
        throw new Error("A pnpm `check` script was not exposed as the typecheck candidate.");
    },
  },
  {
    id: "bun-lockfile-discovery",
    prompt:
      "Repository profiling fails to recognize projects using Bun's current `bun.lock` file. Restore support for that lockfile without regressing support for `bun.lockb`, add or update a focused test, and run the relevant verification.",
    async seed(workspace) {
      await replacement(
        workspace,
        "src/infrastructure/repository/repository-profiler.ts",
        'names.has("bun.lockb") || names.has("bun.lock")',
        'names.has("bun.lockb")',
      );
    },
    async grade(workspace) {
      await assertCommand(workspace, ["test"]);
      const fixture = await mkdtemp(join(tmpdir(), "kairo-bun-grader-"));
      try {
        await Promise.all([
          writeFile(join(fixture, "package.json"), '{"name":"bun-fixture"}\n'),
          writeFile(join(fixture, "bun.lock"), "# bun lockfile\n"),
        ]);
        const module = await import(
          pathToFileURL(join(workspace, "dist/infrastructure/repository/repository-profiler.js"))
            .href
        );
        const profile = await new module.RepositoryProfiler().profile(fixture);
        if (profile.packageManager !== "bun")
          throw new Error("A project with bun.lock was not detected as a Bun repository.");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  },
];

/** Runs real Gemini tasks against clean, Git-free Kairo source snapshots. */
export async function runSelfEvaluationSuite(
  options: SelfEvaluationOptions,
): Promise<SelfEvaluationResult[]> {
  const sourceRoot = options.sourceRoot ?? process.cwd();
  await assertKairoSource(sourceRoot);
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 5)
    throw new Error("Self-evaluation trials must be an integer from 1 to 5.");
  const results: SelfEvaluationResult[] = [];
  for (let trial = 1; trial <= trials; trial += 1)
    for (const scenario of scenarios)
      results.push(await runScenario(sourceRoot, scenario, options, trial));
  return results;
}

/** Copies source without Git history, then installs pinned dependencies in the disposable workspace. */
async function prepareWorkspace(
  sourceRoot: string,
  scenario: SelfEvaluationScenario,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `kairo-self-eval-${scenario.id}-`));
  await cp(sourceRoot, workspace, {
    recursive: true,
    filter: (source) =>
      ![".git", "node_modules", "dist", ".kairo", ".pnpm-store"].includes(basename(source)),
  });
  await assertCommand(workspace, ["install", "--offline", "--frozen-lockfile"]);
  await scenario.seed(workspace);
  return workspace;
}

async function runScenario(
  sourceRoot: string,
  scenario: SelfEvaluationScenario,
  options: SelfEvaluationOptions,
  trial: number,
): Promise<SelfEvaluationResult> {
  let workspace: string | undefined;
  try {
    workspace = await prepareWorkspace(sourceRoot, scenario);
    const store = await SqliteSessionStore.open(":memory:");
    try {
      const session = store.create(workspace);
      const tools = await WorkspaceTools.create(workspace);
      store.saveRepositoryProfile(session.id, await new RepositoryProfiler().profile(workspace));
      const agent = new CodingAgent(
        new GeminiProvider(options.apiKey, options.model, definitions),
        store,
        tools,
        new FixtureApproval(),
        definitions,
      );
      await agent.run(session.id, scenario.prompt, () => {});
      const task = agent.status(session.id)!;
      let expectationPassed = false;
      let error = task.error;
      try {
        await scenario.grade(workspace);
        expectationPassed = true;
      } catch (gradingError) {
        error = `Grading failed: ${(gradingError as Error).message}`;
      }
      const metrics = taskMetrics(store.taskEvents(task.id));
      const verified = task.verificationPassed === true;
      return {
        id: scenario.id,
        trial,
        passed: task.status === "completed" && verified && expectationPassed,
        taskStatus: task.status,
        verified,
        expectationPassed,
        error,
        metrics: {
          modelTurns: metrics.modelTurns,
          toolExecutions: metrics.toolExecutions,
          toolFailures: metrics.toolFailures,
          approvals: metrics.approvals,
          repairs: metrics.repairs,
          verificationPasses: metrics.verificationPasses,
          verificationFailures: metrics.verificationFailures,
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
      trial,
      passed: false,
      taskStatus: "failed",
      verified: false,
      expectationPassed: false,
      error: (error as Error).message,
      metrics: emptyMetrics(),
    };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}

/** Eval-only approval is safe because every mutation occurs in the ephemeral source copy. */
class FixtureApproval implements ApprovalPolicy {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}

/** Runs Kairo's normal package manager through a bounded child process for setup and grading. */
function assertCommand(workspace: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-12_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`pnpm ${args.join(" ")} exited with ${code}: ${output}`));
    });
  });
}

async function assertKairoSource(root: string): Promise<void> {
  try {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    await readFile(join(root, "src/application/coding-agent.ts"), "utf8");
    if (packageJson.name !== "kairo") throw new Error();
  } catch {
    throw new Error("Run `kairo eval self` from the Kairo repository root.");
  }
}

function emptyMetrics(): SelfEvaluationResult["metrics"] {
  return {
    modelTurns: 0,
    toolExecutions: 0,
    toolFailures: 0,
    approvals: 0,
    repairs: 0,
    verificationPasses: 0,
    verificationFailures: 0,
    modelMs: 0,
    toolMs: 0,
  };
}
