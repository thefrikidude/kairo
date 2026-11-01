import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseNumstat, resolveImport, workspaceMap } from "./workspace-map.js";

test("resolves relative imports to changed files", () => {
  const changed = new Set(["src/a.ts", "src/lib/index.ts", "src/view.tsx"]);
  assert.equal(resolveImport("src/main.ts", "./a.js", changed), "src/a.ts");
  assert.equal(resolveImport("src/main.ts", "./lib", changed), "src/lib/index.ts");
  assert.equal(resolveImport("src/lib/x.ts", "../view.js", changed), "src/view.tsx");
  assert.equal(resolveImport("src/main.ts", "./missing.js", changed), undefined);
  assert.equal(resolveImport("a.ts", "../outside.js", changed), undefined);
});

test("links changed files that import each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kairo-map-links-"));
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: directory });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    await writeFile(join(directory, "seed.txt"), "seed\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
    await writeFile(join(directory, "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    await writeFile(join(directory, "b.ts"), "export const b = 1;\n");
    const map = await workspaceMap(directory);
    assert.deepEqual(map.links, [{ from: "a.ts", to: "b.ts" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses numstat records including binary files", () => {
  const stats = parseNumstat("3\t1\tsrc/a.ts\0-\t-\timage.png\0");
  assert.deepEqual(stats.get("src/a.ts"), { additions: 3, deletions: 1 });
  assert.deepEqual(stats.get("image.png"), { additions: 0, deletions: 0 });
});

test("reports churn for modified, untracked and deleted files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kairo-map-"));
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: directory });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/a.ts"), "one\ntwo\n");
    await writeFile(join(directory, "gone.ts"), "x\ny\nz\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
    await writeFile(join(directory, "src/a.ts"), "one\nTWO\nthree\n");
    await writeFile(join(directory, "fresh.ts"), "a\nb\nc\nd\n");
    await rm(join(directory, "gone.ts"));
    const map = await workspaceMap(directory);
    const byPath = new Map(map.nodes.map((node) => [node.path, node]));
    assert.equal(byPath.get("src/a.ts")?.additions, 2);
    assert.equal(byPath.get("src/a.ts")?.deletions, 1);
    assert.equal(byPath.get("fresh.ts")?.additions, 4);
    assert.equal(byPath.get("gone.ts")?.deletions, 3);
    assert.equal(byPath.get("gone.ts")?.mtimeMs, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a folder without Git as unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kairo-map-plain-"));
  try {
    const map = await workspaceMap(directory);
    assert.deepEqual(map.nodes, []);
    assert.ok(map.unavailable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
