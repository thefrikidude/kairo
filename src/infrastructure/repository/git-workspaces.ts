import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitWorktree, TaskWorkspace } from "../../domain/task-workspace.js";
import { stateDir } from "../filesystem/platform-paths.js";

const execute = promisify(execFile);
const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
type WorkspaceDescription = Omit<TaskWorkspace, "id" | "createdAt" | "removedAt">;

async function command(directory: string, args: string[]): Promise<string> {
  try {
    return (
      await execute(git, args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      })
    ).stdout;
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(detail.stderr?.trim() || detail.message || "Git operation failed.");
  }
}

/** Async, argv-only Git operations; repository lifecycle mutations are serialized. */
export class GitWorkspaces {
  private mutations = new Map<string, Promise<unknown>>();
  constructor(private readonly managedRoot = join(stateDir(), "worktrees")) {}

  async describe(requested: string): Promise<WorkspaceDescription> {
    const directory = await realpath(requested);
    if (!(await stat(directory)).isDirectory()) throw new Error("Choose a project folder.");
    try {
      if ((await command(directory, ["rev-parse", "--is-bare-repository"])).trim() === "true")
        throw new Error("Bare repositories cannot be used as task workspaces.");
    } catch (error) {
      if ((error as Error).message.includes("not a git repository"))
        return { repositoryPath: directory, directory, kind: "folder", managed: false };
      throw error;
    }
    const root = await realpath(
      (await command(directory, ["rev-parse", "--show-toplevel"])).trim(),
    );
    const worktrees = await this.list(root);
    const repositoryPath = await realpath(worktrees[0]?.directory ?? root);
    const tree = worktrees.find((item) => item.directory === root);
    return {
      repositoryPath,
      directory,
      kind: root === repositoryPath ? "checkout" : "worktree",
      branch: tree?.branch,
      managed: false,
    };
  }

  async list(directory: string): Promise<GitWorktree[]> {
    const output = await command(directory, ["worktree", "list", "--porcelain", "-z"]);
    const trees: GitWorktree[] = [];
    let current: GitWorktree | undefined;
    for (const field of output.split("\0")) {
      if (field.startsWith("worktree ")) {
        current = { directory: field.slice(9), head: "", locked: false, prunable: false };
        trees.push(current);
      } else if (current) {
        if (field.startsWith("HEAD ")) current.head = field.slice(5);
        else if (field.startsWith("branch refs/heads/")) current.branch = field.slice(18);
        else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
        else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
      }
    }
    return trees;
  }

  private async serialize<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(repository) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.mutations.set(repository, pending);
    try {
      return await pending;
    } finally {
      if (this.mutations.get(repository) === pending) this.mutations.delete(repository);
    }
  }

  async create(requested: string, branch: string, baseRef = "HEAD"): Promise<WorkspaceDescription> {
    const project = await this.describe(requested);
    if (project.kind === "folder")
      throw new Error("Initialize Git and create a commit before starting an isolated task.");
    return this.serialize(project.repositoryPath, async () => {
      if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-"))
        throw new Error("Enter a valid branch name.");
      if (typeof baseRef !== "string" || !baseRef.trim() || baseRef.startsWith("-"))
        throw new Error("Choose a valid base branch or commit.");
      await command(project.directory, ["check-ref-format", "--branch", branch]);
      const baseCommit = (
        await command(project.directory, ["rev-parse", "--verify", `${baseRef}^{commit}`])
      ).trim();
      const key = createHash("sha256").update(project.repositoryPath).digest("hex").slice(0, 20);
      const parent = join(this.managedRoot, key);
      await mkdir(parent, { recursive: true });
      const directory = join(await realpath(parent), randomUUID());
      await command(project.directory, ["worktree", "add", "-b", branch, directory, baseCommit]);
      return {
        repositoryPath: project.repositoryPath,
        directory: await realpath(directory),
        kind: "worktree",
        branch,
        baseCommit,
        managed: true,
      };
    });
  }

  async existing(requested: string, selected: string): Promise<WorkspaceDescription> {
    const project = await this.describe(requested);
    if (project.kind === "folder") throw new Error("This project has no Git worktrees.");
    const directory = await realpath(selected);
    const trees = await this.list(project.repositoryPath);
    const tree = trees.find((entry) => entry.directory === directory);
    if (!tree || tree.prunable)
      throw new Error("Choose an existing worktree belonging to this repository.");
    return this.describe(directory);
  }

  async remove(workspace: TaskWorkspace): Promise<void> {
    if (!workspace.managed || workspace.kind !== "worktree")
      throw new Error("Only worktrees created by Kairo can be removed here.");
    await this.serialize(workspace.repositoryPath, async () => {
      const current = await this.existing(workspace.repositoryPath, workspace.directory);
      if (current.kind !== "worktree") throw new Error("The primary checkout cannot be removed.");
      const changes = await command(workspace.directory, [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored",
        "--untracked-files=all",
      ]);
      if (changes)
        throw new Error(
          "This worktree contains staged, unstaged, untracked or ignored files. Keep it until those files are saved elsewhere or removed.",
        );
      const head = (await command(workspace.directory, ["rev-parse", "HEAD"])).trim();
      if (head !== workspace.baseCommit) {
        // Keep all branch commits unless Git proves they are already reachable from the primary checkout.
        try {
          await command(workspace.repositoryPath, ["merge-base", "--is-ancestor", head, "HEAD"]);
        } catch {
          throw new Error(
            "This worktree has commits that are not merged into the primary checkout. Merge or preserve them before removing it.",
          );
        }
      }
      await command(workspace.repositoryPath, ["worktree", "remove", "--", workspace.directory]);
      // Never delete its branch: saved commits remain recoverable even after removing the directory.
    });
  }
}
