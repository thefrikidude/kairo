import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteSessionStore } from "../dist/infrastructure/persistence/sqlite-session-store.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-ui-smoke-")));
const output = resolve(
  process.env.KAIRO_SMOKE_OUTPUT || join(tmpdir(), `kairo-desktop-evidence-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const project = join(root, "project");
await mkdir(join(project, "src"), { recursive: true });
await writeFile(
  join(project, "src", "hello.ts"),
  'export const message = "Hello from the workspace";\n',
);
await writeFile(join(project, "README.md"), "# Smoke project\n");
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-b", "main"]);
git(["config", "user.name", "Kairo smoke"]);
git(["config", "user.email", "fixture@example.test"]);
git(["add", "."]);
git(["commit", "-m", "Initial smoke files"]);
const state = join(root, "state");
await mkdir(state);
const store = await SqliteSessionStore.open(join(state, "sessions.sqlite"));
const first = store.create(project);
store.rename(first.id, "Review fixture");
store.addMessage(first.id, { role: "user", content: "Inspect the workspace", createdAt: 1 });
const task = store.startTask(first.id, "Inspect the workspace");
store.updateTask(task.id, { status: "completed", summary: "Fixture complete" });
const second = store.create(project);
store.rename(second.id, "Second session");
store.close();
console.log(`Desktop smoke evidence: ${output}`);
async function launch(restart = false) {
  const child = spawn(
    resolve("node_modules/.bin/electron"),
    [resolve("scripts/desktop-smoke.cjs")],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        KAIRO_STATE_DIR: state,
        KAIRO_SMOKE_OUTPUT: output,
        KAIRO_SMOKE_PROJECT: project,
        KAIRO_SMOKE_FIRST: first.id,
        KAIRO_SMOKE_SECOND: second.id,
        KAIRO_SMOKE_RESTART: restart ? "1" : "0",
      },
    },
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  try {
    return await new Promise((done, fail) => {
      child.once("exit", (value) => done(value ?? 1));
      child.once("error", fail);
    });
  } finally {
    clearTimeout(timer);
  }
}
try {
  const code = await launch();
  process.exitCode = code || (await launch(true));
} finally {
  await rm(root, { recursive: true, force: true });
}
