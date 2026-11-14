import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSavedZoom, writeSavedZoom } from "./zoom-state.js";

test("the saved zoom is restored, and unusable files fall back to 100%", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-zoom-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "window-state.json");
  assert.equal(readSavedZoom(file), 1);
  writeSavedZoom(file, 1.3);
  assert.equal(readSavedZoom(file), 1.3);
  await writeFile(file, JSON.stringify({ zoom: 9 }));
  assert.equal(readSavedZoom(file), 1);
  await writeFile(file, "not json");
  assert.equal(readSavedZoom(file), 1);
  await writeFile(file, JSON.stringify({ zoom: "big" }));
  assert.equal(readSavedZoom(file), 1);
});
