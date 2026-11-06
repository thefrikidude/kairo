import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChangeAttribution, ChangeTracker } from "./change-tracker.js";

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the file change.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("credits a touch to every session working at that moment and ignores idle edits", () => {
  const attribution = new ChangeAttribution();
  attribution.record("a.ts", ["one"]);
  attribution.record("a.ts", ["two"]);
  attribution.record("b.ts", []);
  attribution.record("c.ts", ["one", "two"]);
  assert.deepEqual(attribution.sessionsFor("a.ts").sort(), ["one", "two"]);
  assert.deepEqual(attribution.sessionsFor("b.ts"), []);
  assert.deepEqual(attribution.sessionsFor("c.ts").sort(), ["one", "two"]);
});

test("evicts the least recently touched path at the limit", () => {
  const attribution = new ChangeAttribution(2);
  attribution.record("a", ["s"]);
  attribution.record("b", ["s"]);
  attribution.record("a", ["s"]);
  attribution.record("c", ["s"]);
  assert.deepEqual(attribution.sessionsFor("b"), []);
  assert.deepEqual(attribution.sessionsFor("a"), ["s"]);
  assert.deepEqual(attribution.sessionsFor("c"), ["s"]);
});

test("watches a directory, attributes edits to working sessions and skips ignored folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kairo-tracker-"));
  let working: string[] = ["alpha"];
  const tracker = new ChangeTracker(directory, () => working);
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "node_modules"));
    assert.equal(tracker.start(), true);
    assert.equal(tracker.running, true);
    await writeFile(join(directory, "src/a.ts"), "one\n");
    await writeFile(join(directory, "node_modules/dep.js"), "x\n");
    await until(() => tracker.attribution.sessionsFor("src/a.ts").length > 0);
    assert.deepEqual(tracker.attribution.sessionsFor("src/a.ts"), ["alpha"]);
    working = ["beta"];
    await writeFile(join(directory, "src/a.ts"), "two\n");
    await until(() => tracker.attribution.sessionsFor("src/a.ts").length > 1);
    assert.deepEqual(tracker.attribution.sessionsFor("src/a.ts").sort(), ["alpha", "beta"]);
    assert.deepEqual(tracker.attribution.sessionsFor("node_modules/dep.js"), []);
    tracker.stop();
    assert.equal(tracker.running, false);
  } finally {
    tracker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
