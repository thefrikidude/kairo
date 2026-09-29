import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export type ChangedFileReview = { path: string; diff: string; unavailable?: string };

/** Builds a reviewable working-tree patch for one workspace-relative file. */
export function changedFileReview(workspace: string, path: string): ChangedFileReview {
  const absolute = resolve(workspace, path);
  const workspaceRelative = relative(workspace, absolute);
  if (
    workspaceRelative.startsWith("..") ||
    workspaceRelative === "" ||
    workspaceRelative.includes("../")
  )
    return { path, diff: "", unavailable: "This path is outside the active workspace." };

  const tracked = gitSucceeds(workspace, ["ls-files", "--error-unmatch", "--", path]);
  if (tracked && gitSucceeds(workspace, ["rev-parse", "--verify", "HEAD"])) {
    const diff = gitOutput(workspace, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path]);
    if (diff !== undefined) return { path, diff };
  }
  if (existsSync(absolute)) {
    const diff = gitOutput(workspace, [
      "diff",
      "--no-index",
      "--unified=3",
      "--",
      "/dev/null",
      path,
    ]);
    if (diff) return { path, diff };
    try {
      return {
        path,
        diff: readFileSync(absolute, "utf8"),
        unavailable: "No Git diff is available; showing the current file instead.",
      };
    } catch {
      // Fall through to an actionable empty state.
    }
  }
  return { path, diff: "", unavailable: "No current Git diff is available for this file." };
}

/** Lists working-tree paths using Git's NUL-safe status output when available. */
export function changedWorkspaceFiles(workspace: string): string[] {
  const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
  try {
    const output = execFileSync(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const records = output.split("\0");
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      if (path) paths.push(path);
      if (/[RC]/.test(status)) index += 1;
    }
    return paths;
  } catch {
    return [];
  }
}

/** Returns an exit-code-tolerant Git command result; `git diff` uses exit code 1 for changes. */
function gitOutput(workspace: string, args: string[]): string | undefined {
  const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
  try {
    return execFileSync(git, args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
    });
  } catch (error) {
    const output = (error as { stdout?: string | Buffer }).stdout;
    return typeof output === "string" ? output : output?.toString();
  }
}

function gitSucceeds(workspace: string, args: string[]): boolean {
  const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
  try {
    execFileSync(git, args, { cwd: workspace, stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}
