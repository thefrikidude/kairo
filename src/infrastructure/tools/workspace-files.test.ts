import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "./workspace-files.js";

test("desktop directories load one level and omit dependencies and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "README.md"), "hello");
  await writeFile(join(root, "src", "index.ts"), "export {};");
  await symlink(join(root, "README.md"), join(root, "link.md"));
  const files = await WorkspaceFiles.create(root);
  assert.deepEqual(await files.directory(), [
    { path: "src", name: "src", kind: "directory" },
    { path: "README.md", name: "README.md", kind: "file" },
  ]);
  assert.deepEqual(await files.directory("src"), [
    { path: "src/index.ts", name: "index.ts", kind: "file" },
  ]);
});

test("previews preserve complete content above the agent output cap and reject unsafe buffers", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "kairo-preview-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(root);
  const files = await WorkspaceFiles.create(root);
  const content = "line\n".repeat(15_000);
  await writeFile(join(root, "text.txt"), content);
  assert.equal(await files.read("text.txt"), content);
  await writeFile(join(root, "big.txt"), Buffer.alloc(1_048_577, 65));
  await assert.rejects(files.read("big.txt"), /larger than 1 MB/);
  await writeFile(join(root, "binary"), Buffer.from([65, 0, 66]));
  await assert.rejects(files.read("binary"), /Binary/);
  await writeFile(join(root, "invalid"), Buffer.from([0xff]));
  await assert.rejects(files.read("invalid"), /UTF-8/);
  await writeFile(join(parent, "secret"), "outside");
  await symlink(join(parent, "secret"), join(root, "escape"));
  await assert.rejects(files.read("../secret"), /outside/);
  await assert.rejects(files.read("escape"), /Symlink/);
  await assert.rejects(files.directory(".."), /outside/);
  await assert.rejects(files.read("."), /regular file/);
});
