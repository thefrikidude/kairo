import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluationSuite } from "./evaluation-harness.js";
import { formatEvaluationReport } from "../interface/cli/evaluation-report.js";

test("scripted evaluation verifies fixture state and repair evidence", async () => {
  const results = await runEvaluationSuite();
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.passed));
  assert.equal(results.find((result) => result.id === "create-file")?.verified, true);
  const repair = results.find((result) => result.id === "repair-failing-test");
  assert.equal(repair?.verified, true);
  assert.ok((repair?.metrics.toolExecutions ?? 0) >= 3);
  assert.match(formatEvaluationReport(results), /2\/2 passed/);
});
