import { lstat, readFile, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { gitOutput, workspaceReview, type ReviewScope } from "./workspace-review.js";

export type MapNode = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Last modification time, used to show which files an agent is editing right now. */
  mtimeMs: number;
  binary?: boolean;
};
/** `from` imports `to`; both are changed files in the same scope. */
export type MapLink = { from: string; to: string };
export type WorkspaceMap = {
  nodes: MapNode[];
  links: MapLink[];
  scope: ReviewScope;
  branch?: string;
  now: number;
  unavailable?: string;
};

const maxCountedBytes = 1_048_576;
const maxImportBytes = 256 * 1024;
const scriptFile = /\.(?:[cm]?[jt]sx?)$/;
const importSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"'\n]*)["']/g;

/** Resolves a relative specifier to a changed file, trying the extensions TypeScript maps `.js` to. */
export function resolveImport(
  from: string,
  specifier: string,
  changed: ReadonlySet<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base.startsWith("..")) return undefined;
  const stem = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((extension) => [
      `${stem}${extension}`,
      `${base}${extension}`,
      `${base}/index${extension}`,
    ]),
  ];
  return candidates.find((candidate) => changed.has(candidate));
}

/** Import edges between changed files; deleted and oversized files are skipped. */
async function importLinks(directory: string, nodes: MapNode[]): Promise<MapLink[]> {
  const changed = new Set(nodes.map((node) => node.path));
  const links = new Map<string, MapLink>();
  await Promise.all(
    nodes
      .filter((node) => scriptFile.test(node.path) && node.mtimeMs > 0)
      .map(async (node) => {
        const absolute = resolve(directory, node.path);
        const metadata = await lstat(absolute).catch(() => undefined);
        if (!metadata?.isFile() || metadata.size > maxImportBytes) return;
        const content = await readFile(absolute, "utf8").catch(() => "");
        for (const match of content.matchAll(importSpecifier)) {
          const target = resolveImport(node.path, match[1], changed);
          if (target && target !== node.path)
            links.set(`${node.path}\0${target}`, { from: node.path, to: target });
        }
      }),
  );
  return [...links.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

/** Parses `git diff --numstat -z --no-renames`: `added\tremoved\tpath\0` per file. */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const record of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (match)
      stats.set(match[3], {
        additions: match[1] === "-" ? 0 : Number(match[1]),
        deletions: match[2] === "-" ? 0 : Number(match[2]),
      });
  }
  return stats;
}

function lineCount(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

/** Per-file churn for the changes in a review scope, bounded to what git can report cheaply. */
export async function workspaceMap(
  workspace: string,
  scope: ReviewScope = "working",
  baseCommit?: string,
): Promise<WorkspaceMap> {
  const directory = await realpath(workspace);
  const review = await workspaceReview(directory, scope, baseCommit);
  const now = Date.now();
  if (review.unavailable)
    return {
      nodes: [],
      links: [],
      scope,
      branch: review.branch,
      now,
      unavailable: review.unavailable,
    };
  const comparison = scope === "task" && baseCommit ? baseCommit : "HEAD";
  const stats = parseNumstat(
    await gitOutput(directory, [
      "diff",
      "--numstat",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--relative",
      comparison,
      "--",
      ".",
    ]).catch(() => ""),
  );
  const nodes = await Promise.all(
    review.changes.map(async (change): Promise<MapNode> => {
      const absolute = resolve(directory, change.path);
      const metadata = await lstat(absolute).catch(() => undefined);
      let counts = stats.get(change.path);
      if (!counts && metadata?.isFile() && metadata.size <= maxCountedBytes) {
        // Untracked files and repositories without a first commit have no numstat entry.
        const content = await readFile(absolute, "utf8").catch(() => "");
        counts = { additions: content.includes("\0") ? 0 : lineCount(content), deletions: 0 };
      }
      return {
        path: change.path,
        status: change.status.trim() || "M",
        additions: counts?.additions ?? 0,
        deletions: counts?.deletions ?? 0,
        mtimeMs: metadata?.mtimeMs ?? 0,
        binary: metadata?.isFile() && !counts ? true : undefined,
      };
    }),
  );
  return { nodes, links: await importLinks(directory, nodes), scope, branch: review.branch, now };
}
