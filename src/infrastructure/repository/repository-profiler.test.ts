import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryProfiler } from "./repository-profiler.js";

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
