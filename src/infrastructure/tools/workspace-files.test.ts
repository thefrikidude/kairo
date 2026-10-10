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

test("complete-buffer saves detect external edits, preserve text/permissions and clean temporary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-file-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { chmod, readFile, readdir, stat } = await import("node:fs/promises");
  const files = await WorkspaceFiles.create(root);
  const path = join(root, "script.sh");
  await writeFile(path, "\ufeffecho original\r\n");
  await chmod(path, 0o755);
  const snapshot = await files.snapshot("script.sh");
  assert.equal(snapshot.content, "\ufeffecho original\r\n");
  await writeFile(path, "outside change\n");
  await assert.rejects(files.save("script.sh", "my draft\n", snapshot.revision), /changed outside/);
  assert.equal(await readFile(path, "utf8"), "outside change\n");
  const current = await files.snapshot("script.sh");
  const saved = await files.save("script.sh", "\ufeffecho changed\r\n", current.revision);
  assert.equal(await readFile(path, "utf8"), saved.content);
  assert.equal((await stat(path)).mode & 0o777, 0o755);
  assert.equal(saved.revision, (await files.snapshot("script.sh")).revision);
  assert.deepEqual(await readdir(root), ["script.sh"]);
  await assert.rejects(files.save("script.sh", "draft", undefined), /Reload/);
  await assert.rejects(files.save("../escape", "draft", saved.revision), /outside/);
});

test("filename search finds nested files and excludes dependency folders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-file-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "src", "hello.ts"), "export {};");
  await writeFile(join(root, "node_modules", "hello.ts"), "ignored");
  const files = await WorkspaceFiles.create(root);
  assert.deepEqual(await files.search("HELLO"), { paths: ["src/hello.ts"], limited: false });
});

test("atomic saves support filenames near the filesystem's name length limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-long-file-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "x".repeat(250);
  await writeFile(join(root, name), "original");
  const files = await WorkspaceFiles.create(root);
  const before = await files.snapshot(name);
  await files.save(name, "edited", before.revision);
  assert.equal(await files.read(name), "edited");
});
