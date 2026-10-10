import { execFile } from "node:child_process";
import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { devNull } from "node:os";
import { promisify } from "node:util";
import { WorkspaceFiles } from "./workspace-files.js";

const execute = promisify(execFile);
const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
export type WorkspaceChange = { path: string; status: string; oldPath?: string };
export type ReviewScope = "working" | "task";
export type WorkspaceReview = {
  changes: WorkspaceChange[];
  scope: ReviewScope;
  branch?: string;
  baseCommit?: string;
  unavailable?: string;
};
export type ChangedFileReview = { path: string; diff: string; unavailable?: string };

async function gitOutput(
  workspace: string,
  args: string[],
  allowDifference = false,
): Promise<string> {
  try {
    return (
      await execute(git, args, {
        cwd: workspace,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (allowDifference && failure.code === 1 && typeof failure.stdout === "string")
      return failure.stdout;
    if ((failure as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error(
        "This patch or change list is too large for inline review. Open the repository in your external editor.",
      );
    throw new Error(failure.stderr?.trim() || failure.message || "Git review failed.");
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Includes staged, unstaged and untracked files; task scope also includes committed changes. */
export async function workspaceReview(
  workspace: string,
  scope: ReviewScope = "working",
  baseCommit?: string,
): Promise<WorkspaceReview> {
  const directory = await realpath(workspace);
  let gitRoot: string;
  try {
    gitRoot = await realpath((await gitOutput(directory, ["rev-parse", "--show-toplevel"])).trim());
  } catch (error) {
    if ((error as Error).message.includes("not a git repository"))
      return {
        changes: [],
        scope,
        unavailable:
          "This folder has no Git repository. Browse its files, or initialize Git to review changes.",
      };
    throw error;
  }
  const prefix = relative(gitRoot, directory).split(sep).join("/");
  const local = (path: string): string | undefined =>
    !prefix ? path : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
  const changes = new Map<string, WorkspaceChange>();
  if (scope === "task" && baseCommit) {
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit))
      throw new Error("The task's starting commit is invalid.");
    const fields = (
      await gitOutput(directory, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        "-z",
        baseCommit,
        "--",
        ".",
      ])
    ).split("\0");
    for (let index = 0; index < fields.length - 1; index += 2) {
      const path = local(fields[index + 1]);
      if (path) changes.set(path, { path, status: fields[index] });
    }
  }
  const records = (
    await gitOutput(directory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--",
      ".",
    ])
  ).split("\0");
  for (let index = 0; index < records.length; index += 1) {
    if (!records[index]) continue;
    const status = records[index].slice(0, 2);
    const path = local(records[index].slice(3));
    const oldPath = /[RC]/.test(status) ? local(records[++index] ?? "") : undefined;
    if (path) {
      changes.set(path, { path, status, oldPath });
      if (oldPath) changes.delete(oldPath);
    }
  }
  const branch = (
    await gitOutput(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  return {
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    scope,
    branch: branch || undefined,
    baseCommit: scope === "task" ? baseCommit : undefined,
  };
}

/** Validates paths before Git or a fallback reader sees them, including deleted-file parents. */
async function safePath(workspace: string, path: string): Promise<void> {
  if (!path || isAbsolute(path)) throw new Error("Choose a workspace-relative file.");
  const candidate = resolve(workspace, path);
  if (!within(workspace, candidate) || candidate === workspace)
    throw new Error("Path is outside the workspace.");
  try {
    const actual = await realpath(candidate);
    if (!within(workspace, actual)) throw new Error("Symlink escapes the workspace.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(candidate));
    if (!within(workspace, parent)) throw new Error("Parent directory escapes the workspace.");
  }
}

/** Fetches a bounded patch for a selected file, without external diff drivers or text conversion. */
export async function changedFileReview(
  workspace: string,
  path: string,
  scope: ReviewScope = "working",
  baseCommit?: string,
): Promise<ChangedFileReview> {
  const directory = await realpath(workspace);
  await safePath(directory, path);
  const overview = await workspaceReview(directory, scope, baseCommit);
  const change = overview.changes.find((item) => item.path === path);
  if (overview.unavailable) return { path, diff: "", unavailable: overview.unavailable };
  if (!change)
    return {
      path,
      diff: "",
      unavailable: "This file has no changes in the selected review scope.",
    };
  const comparison = scope === "task" && baseCommit ? baseCommit : "HEAD";
  if (comparison === "HEAD") {
    const hasHead = await gitOutput(directory, ["rev-parse", "--verify", "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!hasHead)
      return {
        path,
        diff: await (await WorkspaceFiles.create(directory)).read(path),
        unavailable: "The repository has no first commit. Showing the complete current file.",
      };
  }
  try {
    if (change.status === "??") {
      const metadata = await lstat(resolve(directory, path));
      if (!metadata.isFile() && !metadata.isSymbolicLink())
        return {
          path,
          diff: "",
          unavailable: "Submodule or directory changes must be reviewed in that repository.",
        };
      if (metadata.size > 1_048_576)
        return {
          path,
          diff: "",
          unavailable: "This file is too large for an inline diff. Open it in your editor.",
        };
      return {
        path,
        diff: await gitOutput(
          directory,
          [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=3",
            "--",
            devNull,
            path,
          ],
          true,
        ),
      };
    }
    const diff = await gitOutput(directory, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=3",
      comparison,
      "--",
      ...(change.oldPath ? [change.oldPath] : []),
      path,
    ]);
    return {
      path,
      diff,
      unavailable: diff ? undefined : "No text patch is available for this change.",
    };
  } catch (error) {
    if ((error as Error).message.includes("ambiguous argument 'HEAD'")) {
      const content = await (await WorkspaceFiles.create(directory)).read(path);
      return {
        path,
        diff: content,
        unavailable: "The repository has no first commit. Showing the complete current file.",
      };
    }
    throw error;
  }
}

/** Compatibility path listing used by task evidence, with errors kept visible in desktop review. */
export async function changedWorkspaceFiles(workspace: string): Promise<string[]> {
  try {
    return (await workspaceReview(workspace)).changes.map((change) => change.path);
  } catch {
    return [];
  }
}
