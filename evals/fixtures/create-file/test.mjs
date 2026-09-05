import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("result file contains done", async () => {
  assert.equal(await readFile("result.txt", "utf8"), "done\n");
});
