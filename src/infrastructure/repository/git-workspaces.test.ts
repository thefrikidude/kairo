import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspaces } from "./git-workspaces.js";
import type { TaskWorkspace } from "../../domain/task-workspace.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-worktrees-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repository with spaces");
  await mkdir(repo);
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Kairo fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  await writeFile(join(repo, "hello.txt"), "original\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  git(["add", "."]);
  git(["commit", "-m", "Initial"]);
  const worktrees = new GitWorkspaces(join(root, "managed"));
  return { root, repo, git, worktrees };
}

test("isolated worktrees share repository identity and preserve independent files", async (t) => {
  const { repo, git, worktrees } = await fixture(t);
  const [a, b] = await Promise.all([
    worktrees.create(repo, "kairo/a"),
    worktrees.create(repo, "kairo/b"),
  ]);
  assert.equal(a.repositoryPath, repo);
  assert.equal(b.repositoryPath, repo);
  assert.notEqual(a.directory, b.directory);
  assert.equal(a.baseCommit, git(["rev-parse", "HEAD"]));
  assert.equal((await worktrees.describe(a.directory)).repositoryPath, repo);
  await writeFile(join(a.directory, "hello.txt"), "changed in a\n");
  assert.equal(git(["status", "--porcelain"], b.directory), "");
  assert.equal(git(["status", "--porcelain"], repo), "");
  assert.equal((await worktrees.existing(repo, b.directory)).branch, "kairo/b");
  const list = await worktrees.list(repo);
  assert.deepEqual(list.map((tree) => tree.branch).sort(), ["kairo/a", "kairo/b", "main"]);
  await assert.rejects(worktrees.create(repo, "kairo/b"), /already exists/);
  await assert.rejects(worktrees.create(repo, "--bad"), /valid branch/);
  await assert.rejects(worktrees.create(repo, "kairo/c", "--bad"), /valid base/);
});

test("worktree removal preserves edits, ignored files, unmerged commits and branch history", async (t) => {
  const { repo, git, worktrees } = await fixture(t);
  const tree: TaskWorkspace = {
    ...(await worktrees.create(repo, "kairo/remove")),
    id: "fixture",
    createdAt: Date.now(),
  };
  await writeFile(join(tree.directory, "hello.txt"), "changed\n");
  await assert.rejects(worktrees.remove(tree), /staged, unstaged/);
  git(["restore", "hello.txt"], tree.directory);
  await writeFile(join(tree.directory, "untracked.txt"), "keep");
  await assert.rejects(worktrees.remove(tree), /untracked/);
  await rm(join(tree.directory, "untracked.txt"));
  await writeFile(join(tree.directory, "ignored.txt"), "keep ignored");
  await assert.rejects(worktrees.remove(tree), /ignored/);
  await rm(join(tree.directory, "ignored.txt"));
  await writeFile(join(tree.directory, "hello.txt"), "committed\n");
  git(["add", "."], tree.directory);
  git(["commit", "-m", "Task change"], tree.directory);
  await assert.rejects(worktrees.remove(tree), /not merged/);
  await access(tree.directory);
  git(["merge", "--ff-only", "kairo/remove"]);
  await worktrees.remove(tree);
  await assert.rejects(access(tree.directory));
  assert.ok(git(["show-ref", "--verify", "refs/heads/kairo/remove"]));
  await assert.rejects(worktrees.remove({ ...tree, managed: false }), /Only worktrees/);
});

test("plain folders stay usable and foreign worktrees cannot be selected", async (t) => {
  const { root, repo, worktrees } = await fixture(t);
  const folder = join(root, "plain");
  await mkdir(folder);
  assert.equal((await worktrees.describe(folder)).kind, "folder");
  await assert.rejects(worktrees.create(folder, "kairo/task"), /Initialize Git/);
  await assert.rejects(worktrees.existing(repo, folder), /belonging/);
});
