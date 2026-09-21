import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RepositoryProfiler } from "./repository-profiler.js";
import { RepositoryAwareness } from "./repository-awareness.js";
import { SqliteSessionStore } from "../persistence/sqlite-session-store.js";

const execute = promisify(execFile);
const gitExecutable = process.platform === "darwin" ? "/usr/bin/git" : "git";

async function fixture(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("profiles a pnpm TypeScript project and filters generated paths", async () => {
  const root = await fixture("kairo-profile-");
  await Promise.all([
    mkdir(join(root, "src")),
    mkdir(join(root, "tests")),
    mkdir(join(root, "node_modules")),
    mkdir(join(root, "dist")),
    mkdir(join(root, "generated")),
  ]);
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        scripts: {
          test: "node --test",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          build: "tsc",
        },
      }),
    ),
    writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'"),
    writeFile(join(root, "tsconfig.json"), "{}"),
    writeFile(join(root, ".gitignore"), "generated/\n"),
    writeFile(join(root, "src", "login.ts"), "export const login = true;"),
    writeFile(join(root, "tests", "login.test.ts"), "export {};"),
    writeFile(join(root, "node_modules", "ignored.js"), ""),
    writeFile(join(root, "dist", "ignored.js"), ""),
    writeFile(join(root, "generated", "ignored.ts"), ""),
  ]);

  const profile = await new RepositoryProfiler().profile(root);
  assert.equal(profile.packageName, "fixture-app");
  assert.equal(profile.packageManager, "pnpm");
  assert.deepEqual(profile.sourceRoots, ["src"]);
  assert.deepEqual(profile.testRoots, ["tests"]);
  assert.deepEqual(profile.configFiles, ["tsconfig.json"]);
  assert.deepEqual(
    profile.verificationCandidates.map((item) => item.command),
    ["pnpm test", "pnpm typecheck", "pnpm lint", "pnpm build"],
  );
  assert.deepEqual(profile.verificationCandidates[0]?.evidence, [
    { path: "package.json", kind: "manifest" },
    { path: "pnpm-lock.yaml", kind: "lockfile" },
  ]);
  assert.deepEqual(profile.indexedFiles, [
    ".gitignore",
    "package.json",
    "src/login.ts",
    "tests/login.test.ts",
    "tsconfig.json",
  ]);
});

test("profiles npm and tolerates missing or malformed package metadata", async () => {
  const npmRoot = await fixture("kairo-npm-");
  await Promise.all([
    writeFile(join(npmRoot, "package-lock.json"), "{}"),
    writeFile(join(npmRoot, "package.json"), "{ not json"),
  ]);
  const npmProfile = await new RepositoryProfiler().profile(npmRoot);
  assert.equal(npmProfile.packageManager, "npm");
  assert.deepEqual(npmProfile.scripts, {});
  assert.deepEqual(npmProfile.verificationCandidates, []);

  const emptyRoot = await fixture("kairo-empty-");
  const emptyProfile = await new RepositoryProfiler().profile(emptyRoot);
  assert.equal(emptyProfile.packageManager, "unknown");
  assert.deepEqual(emptyProfile.scripts, {});

  for (const [lockfile, manager] of [
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    const root = await fixture(`kairo-${manager}-`);
    await Promise.all([
      writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}'),
      writeFile(join(root, lockfile), "lock"),
    ]);
    assert.equal((await new RepositoryProfiler().profile(root)).packageManager, manager);
  }
});

test("records local import and test-to-source relationships", async () => {
  const root = await fixture("kairo-relations-");
  await Promise.all([mkdir(join(root, "src")), mkdir(join(root, "tests"))]);
  await Promise.all([
    writeFile(join(root, "src", "validation.ts"), "export const validateEmail = () => true;"),
    writeFile(
      join(root, "src", "login.ts"),
      'import { validateEmail } from "./validation.js"; export { validateEmail };',
    ),
    writeFile(join(root, "tests", "login.test.ts"), 'import "../src/login.js";'),
  ]);
  const profile = await new RepositoryProfiler().profile(root);
  assert.deepEqual(profile.files.find((file) => file.path === "src/login.ts")?.relatedFiles, [
    "src/validation.ts",
    "tests/login.test.ts",
  ]);
  assert.deepEqual(
    profile.files.find((file) => file.path === "tests/login.test.ts")?.relatedFiles,
    ["src/login.ts"],
  );
  assert.ok(
    profile.files
      .find((file) => file.path === "src/validation.ts")
      ?.symbols.includes("validateemail"),
  );
});

test("classifies language-neutral repository signals without following symlinks", async () => {
  const root = await fixture("kairo-universal-");
  const outside = await fixture("kairo-outside-");
  await Promise.all([
    mkdir(join(root, ".github", "workflows"), { recursive: true }),
    mkdir(join(root, ".cursor", "rules"), { recursive: true }),
    mkdir(join(root, "src")),
    mkdir(join(root, "tests")),
    mkdir(join(root, "docs")),
  ]);
  await Promise.all([
    writeFile(join(root, "AGENTS.md"), "repository instructions"),
    writeFile(join(root, ".cursor", "rules", "python.md"), "python rules"),
    writeFile(join(root, "pyproject.toml"), "[project]\nname='demo'"),
    writeFile(join(root, "Makefile"), "test:\n\tpytest"),
    writeFile(join(root, ".github", "workflows", "ci.yml"), "name: ci"),
    writeFile(join(root, "README.md"), "docs"),
    writeFile(join(root, "docs", "architecture.md"), "architecture"),
    writeFile(join(root, "src", "main.py"), "def main(): pass"),
    writeFile(join(root, "tests", "test_main.py"), "def test_main(): pass"),
    writeFile(join(outside, "secret.py"), "secret = True"),
    symlink(outside, join(root, "linked")),
  ]);

  const snapshot = await new RepositoryProfiler().profile(root);
  assert.deepEqual(snapshot.ecosystems, ["python"]);
  assert.deepEqual(snapshot.instructionFiles, [".cursor/rules/python.md", "AGENTS.md"]);
  assert.deepEqual(snapshot.manifestFiles, ["pyproject.toml"]);
  assert.deepEqual(snapshot.ciFiles, [".github/workflows/ci.yml"]);
  assert.deepEqual(snapshot.buildFiles, ["Makefile"]);
  assert.deepEqual(snapshot.documentationFiles, ["README.md", "docs/architecture.md"]);
  assert.ok(
    snapshot.entries.some((entry) => entry.path === "src/main.py" && entry.kind === "source"),
  );
  assert.ok(
    snapshot.entries.some((entry) => entry.path === "tests/test_main.py" && entry.kind === "test"),
  );
  assert.ok(!snapshot.entries.some((entry) => entry.path.includes("secret.py")));
  assert.ok(
    snapshot.instructionFiles.every(
      (path) => snapshot.entries.find((entry) => entry.path === path)?.contentHash,
    ),
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /repository instructions|python rules/);
});

test("Git inventory includes tracked and untracked files but excludes ignored files", async () => {
  const root = await fixture("kairo-git-");
  await execute(gitExecutable, ["init", "-q"], { cwd: root });
  await Promise.all([
    writeFile(join(root, ".gitignore"), "ignored.txt\n"),
    writeFile(join(root, "tracked.py"), "value = 1\n"),
    writeFile(join(root, "deleted.py"), "remove = True\n"),
    writeFile(join(root, "ignored.txt"), "ignored\n"),
  ]);
  await execute(gitExecutable, ["add", ".gitignore", "tracked.py", "deleted.py"], {
    cwd: root,
  });
  await execute(
    gitExecutable,
    ["-c", "user.name=Kairo", "-c", "user.email=kairo@example.com", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  await writeFile(join(root, "untracked.go"), "package main\n");
  await writeFile(join(root, "tracked.py"), "value = 2\n");
  await rm(join(root, "deleted.py"));

  const snapshot = await new RepositoryProfiler().profile(root);
  assert.equal(snapshot.fingerprint.kind, "git");
  assert.ok(snapshot.entries.some((entry) => entry.path === "tracked.py"));
  assert.ok(snapshot.entries.some((entry) => entry.path === "untracked.go"));
  assert.ok(!snapshot.entries.some((entry) => entry.path === "ignored.txt"));
  assert.ok(!snapshot.entries.some((entry) => entry.path === "deleted.py"));
  assert.deepEqual(snapshot.changedPaths, ["deleted.py", "tracked.py", "untracked.go"]);

  await execute(gitExecutable, ["checkout", "-qb", "feature/snapshot"], { cwd: root });
  const branchSnapshot = await new RepositoryProfiler().profile(root);
  assert.equal(branchSnapshot.fingerprint.branch, "feature/snapshot");
  assert.notEqual(branchSnapshot.fingerprint.value, snapshot.fingerprint.value);
  await execute(gitExecutable, ["add", "-A"], { cwd: root });
  await execute(
    gitExecutable,
    ["-c", "user.name=Kairo", "-c", "user.email=kairo@example.com", "commit", "-qm", "change"],
    { cwd: root },
  );
  const headSnapshot = await new RepositoryProfiler().profile(root);
  assert.notEqual(headSnapshot.fingerprint.head, snapshot.fingerprint.head);
  assert.notEqual(headSnapshot.fingerprint.value, branchSnapshot.fingerprint.value);
});

test("repository awareness reuses current snapshots and rebuilds stale ones", async () => {
  const root = await fixture("kairo-awareness-");
  await Promise.all([
    writeFile(join(root, "go.mod"), "module example.com/demo\n"),
    writeFile(join(root, "AGENTS.md"), "original instructions\n"),
  ]);
  const store = await SqliteSessionStore.open(":memory:");
  const session = store.create(root);
  const awareness = new RepositoryAwareness(store);
  const first = await awareness.ensureFresh(session.id, root);
  const reused = await awareness.ensureFresh(session.id, root);
  assert.equal(reused.createdAt, first.createdAt);
  await writeFile(join(root, "AGENTS.md"), "changed instructions\n");
  const instructionRebuild = await awareness.ensureFresh(session.id, root);
  assert.notEqual(instructionRebuild.fingerprint.value, first.fingerprint.value);
  await writeFile(join(root, "go.mod"), "module example.com/changed\n");
  const rebuilt = await awareness.ensureFresh(session.id, root);
  assert.notEqual(rebuilt.fingerprint.value, instructionRebuild.fingerprint.value);
  assert.notEqual(
    rebuilt.entries.find((entry) => entry.path === "go.mod")?.contentHash,
    first.entries.find((entry) => entry.path === "go.mod")?.contentHash,
  );
  store.close();
});

test("reports inventory truncation and avoids hashing oversized control files", async () => {
  const root = await fixture("kairo-limits-");
  await Promise.all([
    writeFile(join(root, "AGENTS.md"), "instructions beyond limit"),
    writeFile(join(root, "a.py"), "a = 1"),
    writeFile(join(root, "b.py"), "b = 2"),
  ]);
  const snapshot = await new RepositoryProfiler({
    maxInventoryEntries: 2,
    maxControlFileBytes: 4,
  }).profile(root);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.entries.length, 2);
  assert.equal(
    snapshot.entries.find((entry) => entry.path === "AGENTS.md")?.contentHash,
    undefined,
  );
});
