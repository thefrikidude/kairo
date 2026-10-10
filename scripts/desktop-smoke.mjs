import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitWorkspaces } from "../dist/infrastructure/repository/git-workspaces.js";
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
if (process.env.KAIRO_SMOKE_LARGE === "1") {
  for (let batch = 0; batch < 16; batch += 1)
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) =>
        writeFile(
          join(project, `file-${String(batch * 100 + offset).padStart(4, "0")}.txt`),
          "fixture\n",
        ),
      ),
    );
  await writeFile(
    join(project, "src", "large.ts"),
    Array.from({ length: 10_000 }, (_, index) => `export const value${index} = ${index};`).join(
      "\n",
    ) + "\n",
  );
}
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
const worktrees = new GitWorkspaces(join(state, "worktrees"));
const historyWorkspace = store.registerWorkspace(
  await worktrees.create(project, "kairo/archived-history"),
);
const archived = store.create(historyWorkspace.directory);
store.rename(archived.id, "Archived removed worktree");
store.addMessage(archived.id, {
  role: "user",
  content: "Keep this conversation after removing its worktree.",
  createdAt: 1,
});
store.addMessage(archived.id, {
  role: "model",
  agentName: "Kairo",
  content: "Saved history remains available in the archive.",
  createdAt: 2,
});
const historyTask = store.startTask(archived.id, "Keep saved history");
store.updateTask(historyTask.id, {
  status: "completed",
  summary: "Archive fixture complete",
  verificationCommand: "node --test",
  verificationPassed: true,
  verificationOutput: "1 test passed",
});
store.archive(archived.id);
await worktrees.remove(historyWorkspace);
store.markWorkspaceRemoved(historyWorkspace.id);
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
        KAIRO_SMOKE_ARCHIVED: archived.id,
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
  if (!code) {
    const pids = JSON.parse(await readFile(join(output, "terminal-pids.json"), "utf8"));
    for (const pid of pids) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error(`Terminal ${pid} survived application shutdown.`);
    }
  }
  process.exitCode = code || (await launch(true));
} finally {
  await rm(root, { recursive: true, force: true });
}
