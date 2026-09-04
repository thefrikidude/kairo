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
  files: [],
  verificationCandidates: [],
  createdAt: 1,
};

test("ranks task-relevant source and test files ahead of unrelated files", () => {
  const selected = new ContextSelector().select("Fix the login validation test", profile);
  assert.deepEqual(new Set(selected.slice(0, 2)), new Set(["src/login.ts", "tests/login.test.ts"]));
  assert.ok(selected.indexOf("src/payments.ts") > selected.indexOf("src/login.ts"));
});

test("uses source terms, symbols, and relationships to rank code beyond filenames", () => {
  const richProfile: RepositoryProfile = {
    ...profile,
    indexedFiles: ["src/login.ts", "src/validation.ts", "tests/login.test.ts"],
    files: [
      {
        path: "src/login.ts",
        terms: [],
        symbols: [],
        imports: ["./validation"],
        relatedFiles: ["src/validation.ts", "tests/login.test.ts"],
      },
      {
        path: "src/validation.ts",
        terms: ["validateemail", "email"],
        symbols: ["validateemail"],
        imports: [],
        relatedFiles: ["src/login.ts"],
      },
      {
        path: "tests/login.test.ts",
        terms: [],
        symbols: [],
        imports: ["../src/login"],
        relatedFiles: ["src/login.ts"],
      },
    ],
  };
  const selected = new ContextSelector().select(
    "ReferenceError: validateEmail is not defined",
    richProfile,
  );
  assert.equal(selected[0], "src/validation.ts");
  assert.ok(selected.indexOf("src/login.ts") < selected.indexOf("tests/login.test.ts"));
});
