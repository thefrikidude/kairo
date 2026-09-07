import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryProfile } from "../domain/models.js";
import { VerificationPlanner } from "./verification-planner.js";

const planner = new VerificationPlanner();
const profile: Pick<
  RepositoryProfile,
  "sourceRoots" | "testRoots" | "configFiles" | "verificationCandidates"
> = {
  sourceRoots: ["src"],
  testRoots: ["test"],
  configFiles: ["tsconfig.json"],
  verificationCandidates: [
    { label: "test", command: "pnpm test" },
    { label: "typecheck", command: "pnpm check" },
    { label: "lint", command: "pnpm lint" },
  ],
};

test("verification planner selects a focused test command for test changes", () => {
  assert.deepEqual(planner.select(profile, ["test/login.test.ts"]), {
    command: "pnpm test",
    label: "test",
    scope: "focused",
    reason: "Changed or failing test file is covered by the test script.",
    source: "recommended",
  });
});

test("verification planner selects focused typechecking for source changes", () => {
  assert.deepEqual(planner.select(profile, ["src/login.ts"]), {
    command: "pnpm check",
    label: "typecheck",
    scope: "focused",
    reason: "Changed source file is covered by typechecking.",
    source: "recommended",
  });
});

test("verification planner broadens config and unknown-file checks", () => {
  assert.equal(planner.select(profile, ["tsconfig.json"])?.scope, "broad");
  assert.equal(planner.select(profile, ["README.md"])?.scope, "broad");
  assert.equal(planner.select(profile, ["README.md"])?.command, "pnpm test");
});

test("verification planner escalates from a focused typecheck to the broader test command", () => {
  const focused = planner.select(profile, ["src/login.ts"]);
  assert.equal(planner.broader(profile, focused!)?.command, "pnpm test");
  assert.equal(planner.broader(profile, focused!)?.scope, "broad");
});
