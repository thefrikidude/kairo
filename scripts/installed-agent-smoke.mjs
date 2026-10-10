// Opt-in: sends small local proof tasks to installed, authenticated Codex/OpenCode CLIs.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { TerminalAgentDiscovery } from "../dist/infrastructure/agents/terminal-agent-discovery.js";
import { SqliteTerminalSessionStore } from "../dist/infrastructure/persistence/sqlite-terminal-session-store.js";
import { GitWorkspaces } from "../dist/infrastructure/repository/git-workspaces.js";
const catalog = await new TerminalAgentDiscovery().refresh();
const installed = Object.fromEntries(
  ["codex", "opencode"].map((id) => [id, catalog.find((agent) => agent.id === id)?.executable]),
);
if (!installed.codex || !installed.opencode)
  throw new Error("Install Codex and OpenCode before this opt-in smoke.");
const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-installed-ui-"))),
  project = join(root, "project"),
  state = join(root, "state"),
  bin = join(root, "bin");
const output = resolve(
  process.env.KAIRO_NATIVE_OUTPUT || join(tmpdir(), `kairo-installed-evidence-${Date.now()}`),
);
for (const path of [project, state, bin, output])
  await mkdir(path, { recursive: true, mode: 0o700 });
await writeFile(join(project, "README.md"), "# Temporary native terminal workflow\n");
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-b", "main"]);
git(["config", "user.name", "Fixture"]);
git(["config", "user.email", "fixture@example.test"]);
git(["add", "."]);
git(["commit", "-m", "Initial"]);
const store = await SqliteTerminalSessionStore.open(join(state, "sessions.sqlite"));
const workspace = store.registerWorkspace(await new GitWorkspaces().describe(project));
store.setActiveWorkspace(workspace.id);
store.close();
for (const id of ["codex", "opencode"]) {
  const prefix =
    id === "codex"
      ? [
          ...(process.env.KAIRO_NATIVE_CODEX_MODEL
            ? ["--model", process.env.KAIRO_NATIVE_CODEX_MODEL]
            : []),
          "--sandbox",
          "workspace-write",
        ]
      : process.env.KAIRO_NATIVE_OPENCODE_MODEL
        ? ["--model", process.env.KAIRO_NATIVE_OPENCODE_MODEL]
        : [];
  // Test-only executable wrappers select a working native model without changing the user's CLI configuration.
  const source = `#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn(${JSON.stringify(installed[id])},${JSON.stringify(prefix)}.concat(process.argv.slice(2)),{stdio:'inherit'});child.on('exit',(code)=>process.exit(code??1));child.on('error',()=>process.exit(1));`;
  await writeFile(join(bin, id), source, { mode: 0o755 });
}
console.log(`Installed-agent evidence: ${output}`);
async function launch(restart) {
  const child = spawn(
    resolve("node_modules/.bin/electron"),
    [resolve("scripts/installed-agent-smoke.cjs")],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        ELECTRON_RENDERER_URL: "",
        KAIRO_STATE_DIR: state,
        KAIRO_NATIVE_OUTPUT: output,
        KAIRO_NATIVE_PROJECT: project,
        KAIRO_NATIVE_RESTART: restart ? "1" : "0",
      },
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
  try {
    return await new Promise((done, fail) => {
      child.once("exit", (code) => done(code ?? 1));
      child.once("error", fail);
    });
  } finally {
    clearTimeout(timer);
  }
}
try {
  for (const restart of [false, true]) {
    const code = await launch(restart);
    if (code)
      throw new Error(`Installed desktop ${restart ? "restart" : "workflow"} failed (${code})`);
    const pids = JSON.parse(
      await readFile(join(output, restart ? "restart-pids.json" : "terminal-pids.json"), "utf8"),
    );
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") continue;
        throw error;
      }
      throw new Error(`Owned terminal ${pid} survived shutdown`);
    }
  }
  console.log("Installed-agent workflow/restart passed; owned terminals stopped.");
} finally {
  await rm(root, { recursive: true, force: true });
}
