#!/usr/bin/env node
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig, setConfig } from "../../infrastructure/configuration/config.js";
import { MacOSKeychainStore } from "../../infrastructure/security/macos-keychain-store.js";
import { GeminiProvider } from "../../infrastructure/providers/gemini-provider.js";
import { SqliteSessionStore } from "../../infrastructure/persistence/sqlite-session-store.js";
import { WorkspaceTools, definitions } from "../../infrastructure/tools/workspace-tools.js";
import { RepositoryProfiler } from "../../infrastructure/repository/repository-profiler.js";
import { CodingAgent } from "../../application/coding-agent.js";
import { runRepl } from "./repl.js";
import { runEvaluationSuite } from "../../application/evaluation-harness.js";
import { runLiveEvaluationSuite } from "../../application/live-evaluation.js";
import { runSelfEvaluationSuite } from "../../application/self-evaluation.js";
import {
  formatEvaluationReport,
  formatEvaluationHistory,
  formatEvaluationRun,
  formatLiveEvaluationReport,
  formatSelfEvaluationReport,
} from "./evaluation-report.js";

import { compareWithBaseline } from "../../application/evaluation-comparison.js";
import { formatBaseline, formatComparison } from "./evaluation-comparison-report.js";

/** Prints the supported command-line shapes when arguments are invalid. */
function usage(): void {
  console.log(
    "Usage: kairo [workspace] | kairo eval [--json] | kairo eval live [--json] | kairo eval self [--trials <1-5>] [--json] | kairo eval history [--json] | kairo eval show <run-id> [--json] | kairo eval baseline set <run-id> [--json] | kairo eval baseline show [--json] | kairo eval compare <run-id> [--json] | kairo auth login|logout|status | kairo config get|set model [value] | kairo sessions list | kairo resume <id>",
  );
}
/** Asks for a one-line credential before sending it to the Keychain adapter. */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const value = await rl.question(question);
  rl.close();
  return value;
}
/** Parses CLI commands, wires concrete adapters, and starts the workspace REPL. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const credentials = new MacOSKeychainStore();
  if (args[0] === "eval") {
    if (args[1] === "baseline" || args[1] === "compare") {
      const positional = args.filter((arg) => arg !== "--json");
      const isSet =
        positional[1] === "baseline" && positional[2] === "set" && positional.length === 4;
      const isShow =
        positional[1] === "baseline" && positional[2] === "show" && positional.length === 3;
      const isCompare = positional[1] === "compare" && positional.length === 3;
      if (!isSet && !isShow && !isCompare)
        throw new Error(
          "Usage: kairo eval baseline set <run-id> | kairo eval baseline show | kairo eval compare <run-id> [--json]",
        );
      const store = await SqliteSessionStore.open();
      try {
        if (isCompare) {
          const comparison = compareWithBaseline(store, positional[2]!);
          if (!comparison)
            throw new Error(
              "No self-evaluation baseline selected. Use kairo eval baseline set <run-id>.",
            );
          console.log(
            args.includes("--json")
              ? JSON.stringify(comparison, null, 2)
              : formatComparison(comparison),
          );
        } else {
          const run = isSet
            ? store.setEvaluationBaseline(positional[3]!)
            : store.evaluationBaseline();
          const result = run ? { run, attempts: store.evaluationAttempts(run.id) } : null;
          console.log(
            args.includes("--json")
              ? JSON.stringify(result, null, 2)
              : result
                ? formatBaseline(result.run, result.attempts)
                : "No self-evaluation baseline selected.",
          );
        }
      } finally {
        store.close();
      }
      return;
    }
    if (args[1] === "history") {
      const store = await SqliteSessionStore.open();
      try {
        const runs = store.evaluationRuns();
        console.log(
          args.includes("--json") ? JSON.stringify(runs, null, 2) : formatEvaluationHistory(runs),
        );
      } finally {
        store.close();
      }
      return;
    }
    if (args[1] === "show") {
      const runId = args[2];
      if (!runId) throw new Error("Provide a run ID: `kairo eval show <run-id>`.");
      const store = await SqliteSessionStore.open();
      try {
        const run = store.evaluationRun(runId);
        if (!run) throw new Error(`Evaluation run not found: ${runId}`);
        const attempts = store.evaluationAttempts(run.id);
        console.log(
          args.includes("--json")
            ? JSON.stringify({ run, attempts }, null, 2)
            : formatEvaluationRun(run, attempts),
        );
      } finally {
        store.close();
      }
      return;
    }
    if (args[1] === "live") {
      const key = await credentials.get();
      if (!key)
        throw new Error("No Gemini credential. Run `kairo auth login` or set GEMINI_API_KEY.");
      const results = await runLiveEvaluationSuite({
        apiKey: key,
        model: (await loadConfig()).model,
      });
      console.log(
        args[2] === "--json"
          ? JSON.stringify(results, null, 2)
          : formatLiveEvaluationReport(results),
      );
      process.exitCode = results.every((result) => result.passed) ? 0 : 1;
      return;
    }
    if (args[1] === "self") {
      const key = await credentials.get();
      if (!key)
        throw new Error("No Gemini credential. Run `kairo auth login` or set GEMINI_API_KEY.");
      const trialIndex = args.indexOf("--trials");
      const trials = trialIndex === -1 ? 1 : Number(args[trialIndex + 1]);
      const store = await SqliteSessionStore.open();
      try {
        const evaluation = await runSelfEvaluationSuite({
          apiKey: key,
          model: (await loadConfig()).model,
          evaluationStore: store,
          trials,
        });
        const comparison = compareWithBaseline(store, evaluation.run.id);
        console.log(
          args.includes("--json")
            ? JSON.stringify({ ...evaluation, ...(comparison ? { comparison } : {}) }, null, 2)
            : [
                formatSelfEvaluationReport(evaluation.results, evaluation.run.id),
                comparison ? formatComparison(comparison) : "",
              ]
                .filter(Boolean)
                .join("\n"),
        );
        process.exitCode = evaluation.results.every((result) => result.passed) ? 0 : 1;
      } finally {
        store.close();
      }
      return;
    }
    const results = await runEvaluationSuite();
    console.log(
      args[1] === "--json" ? JSON.stringify(results, null, 2) : formatEvaluationReport(results),
    );
    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
    return;
  }
  if (args[0] === "auth") {
    if (args[1] === "login") {
      const key = await prompt("Gemini API key (saved in macOS Keychain): ");
      await credentials.save(key);
      console.log("Gemini credential saved.");
      return;
    }
    if (args[1] === "logout") {
      await credentials.clear();
      console.log("Gemini credential removed.");
      return;
    }
    if (args[1] === "status") {
      console.log(
        (await credentials.get())
          ? process.env.GEMINI_API_KEY
            ? "Credential available from GEMINI_API_KEY."
            : "Credential available in macOS Keychain."
          : "Not logged in.",
      );
      return;
    }
    usage();
    process.exitCode = 1;
    return;
  }
  if (args[0] === "config") {
    if (args[1] === "get" && args[2] === "model") {
      console.log((await loadConfig()).model);
      return;
    }
    if (args[1] === "set" && args[2] === "model" && args[3]) {
      await setConfig("model", args[3]);
      console.log("Model saved.");
      return;
    }
    usage();
    process.exitCode = 1;
    return;
  }
  const store = await SqliteSessionStore.open();
  if (args[0] === "sessions" && args[1] === "list") {
    for (const item of store.list())
      console.log(`${item.id}\t${item.workspace}\t${new Date(item.updatedAt).toISOString()}`);
    store.close();
    return;
  }
  const resumeId = args[0] === "resume" ? args[1] : undefined;
  const session = resumeId ? store.get(resumeId) : undefined;
  if (resumeId && !session) throw new Error(`Session not found: ${resumeId}`);
  const workspace = session?.workspace || (await realpath(resolve(args[0] || process.cwd())));
  const key = await credentials.get();
  if (!key) throw new Error("No Gemini credential. Run `kairo auth login` or set GEMINI_API_KEY.");
  const config = await loadConfig();
  const tools = await WorkspaceTools.create(workspace);
  const active = session || store.create(workspace);
  if (!store.repositoryProfile(active.id))
    store.saveRepositoryProfile(active.id, await new RepositoryProfiler().profile(tools.root));
  await runRepl(
    (approval) =>
      new CodingAgent(
        new GeminiProvider(key, config.model, definitions),
        store,
        tools,
        approval,
        definitions,
      ),
    store,
    active,
  );
  store.close();
}
main().catch((error) => {
  console.error(`kairo: ${(error as Error).message}`);
  process.exitCode = 1;
});
