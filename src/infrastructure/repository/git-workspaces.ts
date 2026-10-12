import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { GitWorktree, TaskWorkspace, ProjectRefs } from "../../domain/task-workspace.js";
import { stateDir } from "../filesystem/platform-paths.js";

const execute = promisify(execFile);
const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
type WorkspaceDescription = Omit<TaskWorkspace, "id" | "createdAt" | "removedAt">;

async function command(directory: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return (
      await execute(git, args, {
        cwd: directory,
        signal,
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

  /** Git's index/branch belong to the checkout root, even when a chat starts in a subfolder. */
  async executionRoot(requested: string): Promise<string> {
    const directory = await realpath(requested);
    try {
      return await realpath((await command(directory, ["rev-parse", "--show-toplevel"])).trim());
    } catch (error) {
      if ((error as Error).message.includes("not a git repository")) return directory;
      throw error;
    }
  }

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
      baseCommit:
        tree?.head && /^[a-f0-9]{40,64}$/i.test(tree.head) && !/^0+$/.test(tree.head)
          ? tree.head
          : undefined,
      managed: false,
    };
  }

  async list(directory: string): Promise<GitWorktree[]> {
    let output: string;
    try {
      output = await command(directory, ["worktree", "list", "--porcelain", "-z"]);
    } catch (error) {
      if ((error as Error).message.includes("not a git repository")) return [];
      throw error;
    }
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

  async refs(requested: string, saved?: string, refresh = false): Promise<ProjectRefs> {
    const project = await this.describe(requested);
    if (project.kind === "folder") return { git: false, refs: [], defaultRef: "" };
    if (refresh)
      await this.serialize(project.repositoryPath, () =>
        command(project.repositoryPath, ["fetch", "--all", "--prune"]),
      );
    const refs = (
      await command(project.repositoryPath, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
        "refs/remotes",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ""));
    let defaultRef = saved;
    if (defaultRef) {
      try {
        await command(project.repositoryPath, ["rev-parse", "--verify", `${defaultRef}^{commit}`]);
      } catch {
        throw new Error(
          `Saved base ref “${defaultRef}” is unavailable. Correct it in Project setup.`,
        );
      }
    } else {
      const remoteHeads = [
        "origin/HEAD",
        ...refs.filter((ref) => ref.endsWith("/HEAD") && ref !== "origin/HEAD"),
      ].slice(0, 4);
      for (const remoteHead of remoteHeads) {
        try {
          const candidate = (
            await command(project.repositoryPath, [
              "symbolic-ref",
              "--short",
              `refs/remotes/${remoteHead}`,
            ])
          ).trim();
          await command(project.repositoryPath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
          defaultRef = candidate;
          break;
        } catch {}
      }
      defaultRef ||= (await this.describe(project.repositoryPath)).branch || "HEAD";
      await command(project.repositoryPath, ["rev-parse", "--verify", `${defaultRef}^{commit}`]);
    }
    return { git: true, refs: refs.slice(0, 2000), defaultRef };
  }

  async plan(
    requested: string,
    name: string,
    branch?: string,
    baseRef?: string,
  ): Promise<WorkspaceDescription> {
    const project = await this.describe(requested);
    if (project.kind === "folder")
      throw new Error("Initialize Git and create a commit before starting an isolated task.");
    if (!branch) {
      const slug =
        name
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60) || "task";
      branch = `kairo/${slug}-${randomUUID().slice(0, 8)}`;
    }
    if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-"))
      throw new Error("Enter a valid branch name.");
    const base = baseRef ?? (await this.refs(project.repositoryPath)).defaultRef;
    if (typeof base !== "string" || !base.trim() || base.startsWith("-"))
      throw new Error("Choose a valid base branch or commit.");
    await command(project.repositoryPath, ["check-ref-format", "--branch", branch]);
    const baseCommit = (
      await command(project.repositoryPath, ["rev-parse", "--verify", `${base}^{commit}`])
    ).trim();
    const key = createHash("sha256").update(project.repositoryPath).digest("hex").slice(0, 20);
    const task = `${branch.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64)}-${randomUUID().slice(0, 8)}`;
    return {
      repositoryPath: project.repositoryPath,
      directory: join(this.managedRoot, key, task, basename(project.repositoryPath)),
      kind: "worktree",
      branch,
      baseCommit,
      managed: true,
    };
  }

  async checkout(plan: WorkspaceDescription, signal?: AbortSignal): Promise<WorkspaceDescription> {
    return this.serialize(plan.repositoryPath, async () => {
      signal?.throwIfAborted();
      await mkdir(join(plan.directory, ".."), { recursive: true });
      await command(
        plan.repositoryPath,
        ["worktree", "add", "-b", plan.branch!, plan.directory, plan.baseCommit!],
        signal,
      );
      return { ...plan, directory: await realpath(plan.directory) };
    });
  }

  async create(requested: string, branch: string, baseRef = "HEAD"): Promise<WorkspaceDescription> {
    return this.checkout(await this.plan(requested, branch, branch, baseRef));
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
