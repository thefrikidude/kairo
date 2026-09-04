import test from "node:test";
import assert from "node:assert/strict";
import { FailureAnalyzer } from "./failure-analyzer.js";

test("extracts concise JavaScript failure evidence", () => {
  const evidence = new FailureAnalyzer().analyze(
    "pnpm test",
    "FAIL tests/login.test.ts\nExpected true to equal false\n    at src/auth/login.ts:24:8",
  );
  assert.match(evidence.summary, /FAIL/);
  assert.deepEqual(evidence.fileLocations, [
    { path: "tests/login.test.ts" },
    { path: "src/auth/login.ts", line: 24, column: 8 },
  ]);
  assert.ok(evidence.excerpts.some((line) => line.includes("Expected")));
});
