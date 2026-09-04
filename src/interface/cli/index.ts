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

function usage(): void {
  console.log(
    "Usage: kairo [workspace] | kairo auth login|logout|status | kairo config get|set model [value] | kairo sessions list | kairo resume <id>",
  );
}
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const value = await rl.question(question);
  rl.close();
  return value;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const credentials = new MacOSKeychainStore();
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
