import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFileReview, workspaceReview } from "./workspace-review.js";
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-review-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "code.ts"), "export const value = 1;\n");
  await writeFile(join(root, "remove.txt"), "remove me\n");
  git(["add", "."]);
  git(["commit", "-m", "Initial"]);
  return { root, git, base: git(["rev-parse", "HEAD"]) };
}
test("review includes committed task changes and staged, unstaged, untracked and deleted files", async (t) => {
  const { root, git, base } = await fixture(t);
  await writeFile(join(root, "src", "code.ts"), "export const value = 2;\n");
  git(["add", "."]);
  git(["commit", "-m", "Agent commit"]);
  assert.equal((await workspaceReview(root)).changes.length, 0);
  assert.deepEqual(
    (await workspaceReview(root, "task", base)).changes.map((change) => change.path),
    ["src/code.ts"],
  );
  assert.match(
    (await changedFileReview(root, "src/code.ts", "task", base)).diff,
    /\+export const value = 2/,
  );
  await writeFile(join(root, "src", "code.ts"), "export const value = 3;\n");
  git(["add", "src/code.ts"]);
  await writeFile(join(root, "src", "code.ts"), "export const value = 4;\n");
  await writeFile(join(root, "new\nname.txt"), "new content\n");
  await rm(join(root, "remove.txt"));
  const overview = await workspaceReview(root);
  assert.equal(overview.changes.find((change) => change.path === "src/code.ts")?.status, "MM");
  assert.equal(overview.changes.find((change) => change.path === "new\nname.txt")?.status, "??");
  assert.match((await changedFileReview(root, "remove.txt")).diff, /-remove me/);
  assert.match((await changedFileReview(root, "new\nname.txt")).diff, /\+new content/);
  const subfolder = await workspaceReview(join(root, "src"));
  assert.deepEqual(
    subfolder.changes.map((change) => change.path),
    ["code.ts"],
  );
  assert.match(
    (await changedFileReview(join(root, "src"), "code.ts")).diff,
    /\+export const value = 4/,
  );
});
test("renames retain their original path and binary patches stay reviewable", async (t) => {
  const { root, git } = await fixture(t);
  git(["mv", "remove.txt", "renamed.txt"]);
  const rename = (await workspaceReview(root)).changes.find(
    (change) => change.path === "renamed.txt",
  );
  assert.equal(rename?.oldPath, "remove.txt");
  const diff = (await changedFileReview(root, "renamed.txt")).diff;
  assert.match(diff, /-remove me/);
  assert.match(diff, /\+remove me/);
  await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  assert.match((await changedFileReview(root, "image.bin")).diff, /Binary files/);
});
test("review rejects path escapes and exposes non-Git and invalid-base errors", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(changedFileReview(root, "../outside"), /outside/);
  await symlink(tmpdir(), join(root, "escape"));
  await assert.rejects(changedFileReview(root, "escape/unknown"), /escapes/);
  await assert.rejects(workspaceReview(root, "task", "--bad"), /invalid/);
  const folder = await mkdtemp(join(tmpdir(), "kairo-review-folder-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  assert.match((await workspaceReview(folder)).unavailable ?? "", /no Git repository/);
});

test("staged text files before the first commit have a complete review fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kairo-unborn-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  await writeFile(join(root, "new.txt"), "new file\n");
  execFileSync("git", ["add", "new.txt"], { cwd: root });
  const patch = await changedFileReview(root, "new.txt");
  assert.equal(patch.diff, "new file\n");
  assert.match(patch.unavailable ?? "", /no first commit/);
});

test("read-only review does not refresh or lock Git's index", async (t) => {
  const { root } = await fixture(t);
  const { stat, utimes } = await import("node:fs/promises");
  const index = join(root, ".git", "index");
  const before = await stat(index, { bigint: true });
  await utimes(join(root, "src", "code.ts"), new Date(), new Date(Date.now() + 5_000));
  const overview = await workspaceReview(root);
  assert.equal(overview.changes.length, 0);
  assert.equal((await stat(index, { bigint: true })).mtimeNs, before.mtimeNs);
});

test("selected patches treat wildcard filenames as literal paths", async (t) => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, "*.txt"), "literal original\n");
  git(["add", "."]);
  git(["commit", "-m", "Literal path"]);
  await writeFile(join(root, "*.txt"), "literal changed\n");
  await writeFile(join(root, "remove.txt"), "other file changed\n");
  const patch = await changedFileReview(root, "*.txt");
  assert.match(patch.diff, /literal changed/);
  assert.doesNotMatch(patch.diff, /other file changed/);
});

test("deleted files remain reviewable after their whole directory is removed", async (t) => {
  const { root, git } = await fixture(t);
  git(["rm", "-r", "src"]);
  const patch = await changedFileReview(root, "src/code.ts");
  assert.match(patch.diff, /-export const value = 1/);
});
