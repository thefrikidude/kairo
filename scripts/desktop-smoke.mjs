import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { SqliteTerminalSessionStore } from "../dist/infrastructure/persistence/sqlite-terminal-session-store.js";
import { GitWorkspaces } from "../dist/infrastructure/repository/git-workspaces.js";
const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-terminal-ui-")));
const output = resolve(
  process.env.KAIRO_SMOKE_OUTPUT || join(tmpdir(), `kairo-terminal-evidence-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const project = join(root, "project"),
  state = join(root, "state"),
  bin = join(root, "bin"),
  history = join(root, "history");
for (const path of [project, state, bin, history]) await mkdir(path, { recursive: true });
await writeFile(join(project, "README.md"), "# Terminal fixture\n");
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-b", "main"]);
git(["config", "user.name", "Fixture"]);
git(["config", "user.email", "fixture@example.test"]);
git(["add", "."]);
git(["commit", "-m", "Initial"]);
const fixture =
  `#!${process.execPath}\n` +
  (await readFile(new URL("./fixtures/agent-cli.cjs", import.meta.url), "utf8"));
await writeFile(join(bin, "codex"), fixture, { mode: 0o755 });
const store = await SqliteTerminalSessionStore.open(join(state, "sessions.sqlite"));
const workspace = store.registerWorkspace(await new GitWorkspaces().describe(project));
const first = store.create(workspace.id, "codex", "First agent");
store.setActiveSession(first.id);
store.close();
console.log(`Terminal desktop evidence: ${output}`);
async function launch(restart) {
  const child = spawn(
    resolve("node_modules/.bin/electron"),
    [resolve("scripts/desktop-smoke.cjs")],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        SHELL: "/bin/sh",
        KAIRO_STATE_DIR: state,
        KAIRO_FIXTURE_HISTORY: history,
        CODEX_HOME: join(root, "codex"),
        KAIRO_FIXTURE_NATIVE_HOME: join(root, "codex"),
        KAIRO_SMOKE_OUTPUT: output,
        KAIRO_SMOKE_PROJECT: project,
        KAIRO_SMOKE_FIRST: first.id,
        KAIRO_SMOKE_RESTART: restart ? "1" : "0",
      },
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
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
  const firstCode = await launch(false);
  if (firstCode) throw new Error(`Desktop smoke failed (${firstCode})`);
  const secondCode = await launch(true);
  if (secondCode) throw new Error(`Desktop restart failed (${secondCode})`);
  for (const file of ["terminal-pids.json", "restart-pids.json"]) {
    for (const pid of JSON.parse(await readFile(join(output, file), "utf8"))) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") continue;
        throw error;
      }
      throw new Error(`Owned terminal ${pid} survived shutdown.`);
    }
  }
  console.log("Desktop and restart smoke passed; owned terminal processes stopped.");
} finally {
  await rm(root, { recursive: true, force: true });
}
