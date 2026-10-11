import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLifecycle } from "./workspace-lifecycle.js";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import { SqliteTerminalSessionStore } from "../../../infrastructure/persistence/sqlite-terminal-session-store.js";
const execute = promisify(execFile);
const wait = async (predicate: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Preparation timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
};
test("background workspace creation, default refs, failed setup retry, cancellation and interrupted checkout recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-lifecycle-"))),
    repo = join(root, "repo");
  await mkdir(repo);
  const gitCommand = (args: string[]) => execute("git", ["-C", repo, ...args]);
  await gitCommand(["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "base");
  await writeFile(join(repo, ".gitignore"), ".env\nsetup-proof\n");
  await gitCommand(["add", "."]);
  await gitCommand([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=a@b.test",
    "commit",
    "-m",
    "base",
  ]);
  await writeFile(join(repo, ".env"), "secret");
  const store = await SqliteTerminalSessionStore.open(join(root, "state.sqlite")),
    git = new GitWorkspaces(join(root, "trees"));
  const launches: string[] = [];
  const lifecycle = new WorkspaceLifecycle(
    store,
    git,
    () => {},
    async (id) => {
      launches.push(id);
    },
  );
  try {
    await gitCommand(["branch", "custom"]);
    await gitCommand(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await gitCommand(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    assert.equal((await git.refs(repo)).defaultRef, "origin/main");
    assert.equal((await git.refs(repo, "custom")).defaultRef, "custom");
    await assert.rejects(git.refs(repo, "missing-base"));
    await lifecycle.preferences(repo, {
      setupScript: "echo setup; exit 7",
      copyPaths: [".env"],
      baseRef: "custom",
    });
    await lifecycle.create({
      project: repo,
      name: "Fix auth",
      selection: { kind: "worktree", branch: "" },
      agentId: "codex",
    });
    const operation = store.operations()[0];
    assert.ok(operation.branch?.startsWith("kairo/fix-auth-"));
    await wait(() => store.operations()[0].phase === "failed");
    assert.equal(launches.length, 0);
    assert.equal(await readFile(join(operation.directory, ".env"), "utf8"), "secret");
    const id = store.operations()[0].workspaceId!;
    await lifecycle.preferences(repo, { setupScript: "touch setup-proof", copyPaths: [".env"] });
    await lifecycle.retry(operation.id);
    await wait(() => store.operations()[0].phase === "ready");
    assert.equal(store.operations()[0].workspaceId, id);
    await wait(() => launches.length === 1);
    assert.equal(await readFile(join(operation.directory, "setup-proof"), "utf8"), "");
    await lifecycle.preferences(repo, { setupScript: "echo waiting; sleep 60", copyPaths: [] });
    await lifecycle.create({
      project: repo,
      name: "cancel",
      selection: { kind: "worktree", branch: "" },
    });
    const cancel = store.operations()[0];
    await wait(() => store.operations()[0].phase === "setup");
    lifecycle.cancel(cancel.id);
    await wait(() => store.operations()[0].phase === "cancelled");
    assert.ok(store.workspace(store.operations()[0].workspaceId!));
    const plan = await git.plan(repo, "interrupted");
    store.saveOperation({
      id: "interrupted",
      repositoryPath: repo,
      directory: plan.directory,
      name: "Recovered",
      branch: plan.branch,
      baseCommit: plan.baseCommit,
      phase: "checkout",
      createdAt: Date.now(),
      output: "",
      copiedPaths: [],
      preferences: store.preferences(repo),
    });
    await git.checkout(plan);
    await lifecycle.reconcile();
    const recovered = store.operations().find((op) => op.id === "interrupted")!;
    assert.equal(recovered.phase, "interrupted");
    assert.equal(store.workspace(recovered.workspaceId!)?.name, "Recovered");
    await assert.rejects(git.create(repo, operation.branch!), /already exists/);
  } finally {
    await lifecycle.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
