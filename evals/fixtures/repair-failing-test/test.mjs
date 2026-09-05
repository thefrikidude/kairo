import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("message is repaired", async () => {
  assert.equal(await readFile("message.txt", "utf8"), "good\n");
});
