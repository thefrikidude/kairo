// Repeated, identical fixtures. Pass an app checkout directory to compare revisions.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSessionStore } from "../dist/infrastructure/persistence/sqlite-session-store.js";
import { GitWorkspaces } from "../dist/infrastructure/repository/git-workspaces.js";
const appRoot = resolve(process.argv[2] || process.cwd());
const output = resolve(
  process.env.KAIRO_BENCH_OUTPUT || join(tmpdir(), `kairo-benchmark-${Date.now()}`),
);
const count = Number(process.env.KAIRO_BENCH_RUNS || 3);
if (!Number.isInteger(count) || count < 1 || count > 10)
  throw new Error("Benchmark runs must be 1–10.");
const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-benchmark-fixture-")));
await mkdir(output, { recursive: true });
const project = join(root, "project");
await mkdir(project);
await Promise.all(
  Array.from({ length: 100 }, (_, index) =>
    writeFile(join(project, `file-${index}.txt`), "Benchmark source\n"),
  ),
);
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-b", "main"]);
git(["config", "user.name", "Benchmark"]);
git(["config", "user.email", "benchmark@example.test"]);
git(["add", "."]);
git(["commit", "-m", "Fixture"]);
const seed = join(root, "seed.sqlite");
const store = await SqliteSessionStore.open(seed);
const worktrees = new GitWorkspaces(join(root, "worktrees"));
for (let index = 0; index < 24; index += 1) {
  const workspace = store.registerWorkspace(
    await worktrees.create(project, `kairo/benchmark-${index}`),
  );
  const session = store.create(workspace.directory);
  store.rename(session.id, `Benchmark session ${index + 1}`);
  for (let message = 0; message < 10; message += 1)
    store.addMessage(session.id, {
      role: message % 2 ? "model" : "user",
      content: "A short benchmark conversation message.",
      createdAt: message + 1,
    });
}
store.close();
const samples = [];
try {
  for (let index = 0; index < count; index += 1) {
    const state = join(root, `state-${index}`);
    await mkdir(state);
    await copyFile(seed, join(state, "sessions.sqlite"));
    const file = join(output, `sample-${index + 1}.json`);
    const child = spawn(
      join(appRoot, "node_modules/.bin/electron"),
      [fileURLToPath(new URL("./desktop-benchmark.cjs", import.meta.url))],
      {
        cwd: appRoot,
        stdio: "inherit",
        env: { ...process.env, KAIRO_STATE_DIR: state, KAIRO_BENCH_SAMPLE: file },
      },
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    try {
      const code = await new Promise((done, fail) => {
        child.once("exit", done);
        child.once("error", fail);
      });
      if (code !== 0) throw new Error(`Benchmark exited ${code}`);
    } finally {
      clearTimeout(timer);
    }
    samples.push(JSON.parse(await readFile(file, "utf8")));
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" }).trim(),
    machine: { platform: platform(), arch: arch(), cpu: cpus()[0].model, node: process.version },
    fixture: {
      workspaces: 24,
      files: 100,
      messagesPerChat: 10,
      samples: count,
      switchesPerSample: 10,
    },
    median: {
      startupMs: median(samples.map((sample) => sample.startupMs)),
      switchMs: median(samples.flatMap((sample) => sample.switchMs)),
      rssKB: median(samples.map((sample) => sample.rssKB)),
    },
    samples,
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Benchmark report: ${output}`, JSON.stringify(report.median));
} finally {
  await rm(root, { recursive: true, force: true });
}
