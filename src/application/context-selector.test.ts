import test from "node:test";
import assert from "node:assert/strict";
import { ContextSelector } from "./context-selector.js";
import type { RepositoryProfile } from "../domain/models.js";

const profile: RepositoryProfile = {
  root: "/workspace",
  packageManager: "pnpm",
  scripts: {},
  configFiles: [],
  sourceRoots: ["src"],
  testRoots: ["tests"],
  ignoredPaths: [],
  indexedFiles: ["README.md", "src/login.ts", "src/payments.ts", "tests/login.test.ts"],
  verificationCandidates: [],
  createdAt: 1,
};

test("ranks task-relevant source and test files ahead of unrelated files", () => {
  const selected = new ContextSelector().select("Fix the login validation test", profile);
  assert.deepEqual(new Set(selected.slice(0, 2)), new Set(["src/login.ts", "tests/login.test.ts"]));
  assert.ok(selected.indexOf("src/payments.ts") > selected.indexOf("src/login.ts"));
});
