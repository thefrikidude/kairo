import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EvaluationAttempt,
  EvaluationRun,
  SelfEvaluationResult,
  ToolCall,
} from "../domain/models.js";
import type { ApprovalPolicy, EvaluationStore } from "../domain/ports.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";
import { GeminiProvider } from "../infrastructure/providers/gemini-provider.js";
import { RepositoryProfiler } from "../infrastructure/repository/repository-profiler.js";
import { WorkspaceTools, definitions } from "../infrastructure/tools/workspace-tools.js";
import { CodingAgent } from "./coding-agent.js";
import { taskMetrics } from "./task-metrics.js";

export type SelfEvaluationScenario = {
  id: string;
  prompt: string;
  seed(workspace: string): Promise<void>;
  /** Hidden behavioral check, separate from the agent's own verification command. */
  verify(workspace: string): Promise<void>;
};

export type SelfEvaluationOptions = {
  apiKey: string;
  model: string;
  evaluationStore: EvaluationStore;
  trials?: number;
  sourceRoot?: string;
};

export type SelfEvaluationRun = { run: EvaluationRun; results: SelfEvaluationResult[] };

const replacement = async (workspace: string, path: string, before: string, after: string) => {
  const target = join(workspace, path);
  const source = await readFile(target, "utf8");
  if (!source.includes(before)) throw new Error(`Self-eval seed no longer matches ${path}.`);
  await writeFile(target, source.replace(before, after), "utf8");
};

/** Seven real Kairo safeguards, deliberately removed from isolated source copies. */
export const selfEvaluationScenarios: SelfEvaluationScenario[] = [
  {
    id: "verification-check-script",
    prompt:
      "A JavaScript project with only a `check` package script is not offered a typecheck verification command. Fix verification discovery so the `check` script is recognized as typecheck, preserve package-manager command formats, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/application/verification-planner.ts",
        '["typecheck", ["typecheck", "type-check", "check"]]',
        '["typecheck", ["typecheck", "type-check"]]',
      ),
    async verify(workspace) {
      const module = await import(
        pathToFileURL(join(workspace, "dist/application/verification-planner.js")).href
      );
      const candidates = new module.VerificationPlanner().candidates({
        packageManager: "pnpm",
        scripts: { check: "tsc --noEmit" },
      });
      if (candidates[0]?.label !== "typecheck" || candidates[0]?.command !== "pnpm check")
        throw new Error("A pnpm check script was not exposed as typecheck.");
    },
  },
  {
    id: "focused-verification-selection",
    prompt:
      "Kairo no longer recommends the focused typecheck for a changed TypeScript source file. Restore changed-file-aware verification selection, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/application/verification-planner.ts",
        'if (isSource && byLabel("typecheck"))',
        "if (false)",
      ),
    async verify(workspace) {
      const module = await import(
        pathToFileURL(join(workspace, "dist/application/verification-planner.js")).href
      );
      const selection = new module.VerificationPlanner().select(
        {
          sourceRoots: ["src"],
          testRoots: ["test"],
          configFiles: [],
          verificationCandidates: [
            { label: "test", command: "pnpm test" },
            { label: "typecheck", command: "pnpm check" },
          ],
        },
        ["src/login.ts"],
      );
      if (selection?.command !== "pnpm check" || selection.scope !== "broad")
        throw new Error("A changed source file did not select focused typechecking.");
    },
  },
  {
    id: "bun-lockfile-discovery",
    prompt:
      "Repository profiling fails to recognize projects using Bun's current bun.lock file. Restore support without regressing bun.lockb, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/infrastructure/repository/repository-profiler.ts",
        'names.has("bun.lockb") || names.has("bun.lock")',
        'names.has("bun.lockb")',
      ),
    async verify(workspace) {
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
        if ((await new module.RepositoryProfiler().profile(fixture)).packageManager !== "bun")
          throw new Error("A project with bun.lock was not detected as Bun.");
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  },
  {
    id: "context-relationship-ranking",
    prompt:
      "Repository context ranking no longer includes a file connected to an independently relevant file. Restore relationship-aware ranking without replacing direct lexical ranking, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/application/context-selector.ts",
        "const relationshipScore = file.relatedFiles.some((path) => direct.has(path)) ? 3 : 0;",
        "const relationshipScore = 0;",
      ),
    async verify(workspace) {
      const module = await import(
        pathToFileURL(join(workspace, "dist/application/context-selector.js")).href
      );
      const selected = new module.ContextSelector().select("token", {
        root: workspace,
        packageManager: "pnpm",
        scripts: {},
        configFiles: [],
        sourceRoots: [],
        testRoots: [],
        ignoredPaths: [],
        indexedFiles: ["src/entry.ts", "src/token.ts", "src/other.ts"],
        files: [
          {
            path: "src/entry.ts",
            terms: [],
            symbols: [],
            imports: [],
            relatedFiles: ["src/token.ts"],
          },
          {
            path: "src/token.ts",
            terms: ["token"],
            symbols: ["token"],
            imports: [],
            relatedFiles: [],
          },
          { path: "src/other.ts", terms: [], symbols: [], imports: [], relatedFiles: [] },
        ],
        verificationCandidates: [],
        createdAt: 0,
      });
      if (!selected.includes("src/entry.ts")) throw new Error("A related file was not ranked.");
    },
  },
  {
    id: "verifying-task-recovery",
    prompt:
      "After a restart, tasks left in the verifying state are not recovered as interrupted. Restore durable restart recovery for that state, add or update a focused test, and run relevant verification.",
    async seed(workspace) {
      await replacement(
        workspace,
        "src/infrastructure/persistence/sqlite-session-store.ts",
        "status IN ('planning', 'acting', 'verifying')",
        "status IN ('planning', 'acting')",
      );
      await replacement(
        workspace,
        "src/infrastructure/persistence/sqlite-session-store.ts",
        "status IN ('planning', 'acting', 'verifying')",
        "status IN ('planning', 'acting')",
      );
    },
    async verify(workspace) {
      const directory = await mkdtemp(join(tmpdir(), "kairo-recovery-grader-"));
      const fixture = join(directory, "state.sqlite");
      const module = await import(
        pathToFileURL(join(workspace, "dist/infrastructure/persistence/sqlite-session-store.js"))
          .href
      );
      const first = await module.SqliteSessionStore.open(fixture);
      const session = first.create(workspace);
      const task = first.startTask(session.id, "Recover this task");
      first.updateTask(task.id, { status: "verifying" });
      first.close();
      const resumed = await module.SqliteSessionStore.open(fixture);
      try {
        if (resumed.task(task.id)?.status !== "interrupted")
          throw new Error("A verifying task was not interrupted on restart.");
      } finally {
        resumed.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    id: "symlink-escape-read",
    prompt:
      "The workspace read tool accepts a symlink inside the workspace that points outside it. Restore symlink-escape protection for reads without weakening normal workspace access, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/infrastructure/tools/workspace-tools.ts",
        '      const actual = await realpath(candidate);\n      // Resolving first catches a path that looks local but exits through a symlink.\n      if (!this.inside(actual)) throw new Error("Symlink escapes the workspace.");\n      return actual;',
        "    return candidate;",
      ),
    async verify(workspace) {
      const root = await mkdtemp(join(tmpdir(), "kairo-workspace-grader-"));
      const outside = await mkdtemp(join(tmpdir(), "kairo-outside-grader-"));
      try {
        await writeFile(join(outside, "secret.txt"), "not for the workspace\n");
        await symlink(outside, join(root, "escape"));
        const module = await import(
          pathToFileURL(join(workspace, "dist/infrastructure/tools/workspace-tools.js")).href
        );
        const result = await (
          await module.WorkspaceTools.create(root)
        ).execute({ id: "read", name: "read_file", args: { path: "escape/secret.txt" } });
        if (result.ok || !result.output.includes("Symlink escapes the workspace."))
          throw new Error("A read through an escaping symlink was accepted.");
      } finally {
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ]);
      }
    },
  },
  {
    id: "repair-brief-evidence",
    prompt:
      "The focused retry context omits extracted failure excerpts from the repair brief. Restore that evidence while preserving the summary and locations, add or update a focused test, and run relevant verification.",
    seed: (workspace) =>
      replacement(
        workspace,
        "src/application/context-manager.ts",
        '      `Evidence: ${latest.evidence.excerpts.join(" | ") || "inspect the command output"}`,\n',
        "",
      ),
    async verify(workspace) {
      const store = await SqliteSessionStore.open(":memory:");
      try {
        const session = store.create(workspace);
        const task = store.startTask(session.id, "Fix failure");
        store.recordRepairAttempt({
          id: "repair-evidence",
          taskId: task.id,
          command: "pnpm test",
          evidence: {
            summary: "Expected true but received false",
            fileLocations: [{ path: "src/example.ts", line: 4 }],
            excerpts: ["Expected true", "received false"],
          },
          selectedFiles: ["src/example.ts"],
          createdAt: Date.now(),
        });
        const module = await import(
          pathToFileURL(join(workspace, "dist/application/context-manager.js")).href
        );
        const brief = new module.ContextManager(store)
          .prepare(session.id, task)
          .find((message: { content: string }) =>
            message.content.startsWith("Repair attempt"),
          )?.content;
        if (!brief?.includes("Evidence: Expected true | received false"))
          throw new Error("The repair brief did not preserve evidence.");
      } finally {
        store.close();
      }
    },
  },
];

/** Runs real Gemini tasks against clean Git-free snapshots and persists metadata-only outcome evidence. */
export async function runSelfEvaluationSuite(
  options: SelfEvaluationOptions,
): Promise<SelfEvaluationRun> {
  const sourceRoot = options.sourceRoot ?? process.cwd();
  await assertKairoSource(sourceRoot);
  const trials = options.trials ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 5)
    throw new Error("Self-evaluation trials must be an integer from 1 to 5.");
  let run = options.evaluationStore.createEvaluationRun({
    suite: "self",
    model: options.model,
    sourceRevision: await sourceRevision(sourceRoot),
    trialCount: trials,
    startedAt: Date.now(),
    completedAt: undefined,
  });
  const results: SelfEvaluationResult[] = [];
  try {
    for (let trial = 1; trial <= trials; trial += 1)
      for (const scenario of selfEvaluationScenarios) {
        const startedAt = Date.now();
        const result = await runScenario(sourceRoot, scenario, options, trial);
        results.push(result);
        options.evaluationStore.saveEvaluationAttempt(toAttempt(run.id, result, startedAt));
      }
  } finally {
    run = options.evaluationStore.completeEvaluationRun(run.id);
  }
  return { run, results };
}

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
        await assertCommand(workspace, ["test"]);
        await scenario.verify(workspace);
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
        metrics: { ...metrics },
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

function toAttempt(
  runId: string,
  result: SelfEvaluationResult,
  startedAt: number,
): EvaluationAttempt {
  return {
    runId,
    scenarioId: result.id,
    trial: result.trial,
    passed: result.passed,
    taskStatus: result.taskStatus,
    verified: result.verified,
    expectationPassed: result.expectationPassed,
    failureCategory: result.passed ? undefined : classifyFailure(result),
    metrics: result.metrics,
    durationMs: Date.now() - startedAt,
    createdAt: Date.now(),
  };
}
function classifyFailure(result: SelfEvaluationResult): EvaluationAttempt["failureCategory"] {
  if (result.error?.startsWith("Grading failed:")) return "grader";
  if (result.error?.includes("Self-eval seed") || result.error?.includes("pnpm install"))
    return "setup";
  if (!result.verified) return "verification";
  if (result.taskStatus === "failed") return "agent";
  return "unknown";
}
class FixtureApproval implements ApprovalPolicy {
  async approve(_call: ToolCall, _description: string): Promise<boolean> {
    return true;
  }
}
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
function sourceRevision(root: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let value = "";
    child.stdout.on("data", (chunk: Buffer) => (value += chunk));
    child.once("error", () => resolve("unknown"));
    child.once("close", (code) => resolve(code === 0 && value.trim() ? value.trim() : "unknown"));
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
    verificationSelections: 0,
    focusedVerifications: 0,
    broadVerifications: 0,
    repairConverged: false,
    modelMs: 0,
    toolMs: 0,
  };
}
