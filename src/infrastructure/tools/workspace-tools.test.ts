import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTools } from "./workspace-tools.js";

test("workspace tools read, edit, truncate, and reject escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-tools-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.txt"), "one\ntwo\n");
  const tools = await WorkspaceTools.create(root);
  assert.match(
    (await tools.execute({ id: "1", name: "read_file", args: { path: "src/a.txt" } })).output,
    /one/,
  );
  assert.match(
    (
      await tools.execute({
        id: "range",
        name: "read_file_range",
        args: { path: "src/a.txt", startLine: 2, endLine: 2 },
      })
    ).output,
    /2: two/,
  );
  assert.equal(
    (
      await tools.execute({
        id: "2",
        name: "edit_file",
        args: { path: "src/a.txt", oldText: "two", newText: "three" },
      })
    ).ok,
    true,
  );
  assert.match(
    (await tools.execute({ id: "3", name: "search_files", args: { query: "three" } })).output,
    /three/,
  );
  assert.equal(
    (await tools.execute({ id: "4", name: "read_file", args: { path: "../outside" } })).ok,
    false,
  );
  await symlink(tmpdir(), join(root, "escape"));
  assert.equal(
    (await tools.execute({ id: "5", name: "read_file", args: { path: "escape/nope" } })).ok,
    false,
  );
  assert.equal(
    (
      await tools.execute({
        id: "invalid-range",
        name: "read_file_range",
        args: { path: "src/a.txt", startLine: 0, endLine: 2 },
      })
    ).ok,
    false,
  );
});
