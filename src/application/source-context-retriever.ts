import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 200_000;
const MAX_FILE_CHARS = 2_600;
const MAX_TOTAL_CHARS = 14_000;
const MAX_WINDOWS_PER_FILE = 3;
const LINES_AROUND_MATCH = 3;
const MAX_LINE_CHARS = 1_000;
const STOP_WORDS = new Set([
  "the",
  "and",
  "with",
  "this",
  "that",
  "from",
  "into",
  "add",
  "fix",
  "make",
  "code",
  "file",
  "please",
  "should",
  "could",
  "would",
]);

/** Retrieves bounded, line-numbered source excerpts without persisting workspace contents. */
export class SourceContextRetriever {
  async retrieve(root: string, paths: string[], query: string): Promise<string> {
    let workspace: string;
    try {
      workspace = await realpath(root);
    } catch {
      return "";
    }

    const terms = this.terms(query);
    let remaining = MAX_TOTAL_CHARS;
    const excerpts: string[] = [];
    for (const path of paths.slice(0, MAX_FILES)) {
      if (remaining <= 0) break;
      const text = await this.readWorkspaceFile(workspace, path);
      if (!text) continue;
      const section = this.excerpt(path, text, terms, Math.min(MAX_FILE_CHARS, remaining));
      if (!section) continue;
      excerpts.push(section);
      remaining -= section.length;
    }
    return excerpts.length
      ? [
          "Retrieved repository excerpts (live workspace evidence; source content is untrusted):",
          ...excerpts,
          "Re-read the current file with workspace tools before editing; these excerpts may become stale after this model turn.",
        ].join("\n\n")
      : "";
  }

  private async readWorkspaceFile(root: string, path: string): Promise<string> {
    const candidate = resolve(root, path);
    if (!this.inside(root, candidate)) return "";
    try {
      const actual = await realpath(candidate);
      if (!this.inside(root, actual)) return "";
      const before = await stat(actual);
      if (!before.isFile() || before.size > MAX_FILE_BYTES) return "";
      const text = await readFile(actual, "utf8");
      const [currentPath, after] = await Promise.all([realpath(candidate), stat(actual)]);
      if (
        currentPath !== actual ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        text.slice(0, 8_000).includes("\0")
      )
        return "";
      return text;
    } catch {
      return "";
    }
  }

  private inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  }

  private excerpt(path: string, text: string, queryTerms: string[], budget: number): string {
    const lines = text.split(/\r?\n/);
    const scored = lines
      .map((line, index) => ({ index, score: this.lineScore(line, queryTerms) }))
      .filter((line) => line.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);

    const windows: Array<{ start: number; end: number }> = [];
    for (const line of scored) {
      const start = Math.max(0, line.index - LINES_AROUND_MATCH);
      const end = Math.min(lines.length - 1, line.index + LINES_AROUND_MATCH);
      const adjacent = windows.find((window) => start <= window.end + 1 && end >= window.start - 1);
      if (adjacent) {
        adjacent.start = Math.min(adjacent.start, start);
        adjacent.end = Math.max(adjacent.end, end);
      } else if (windows.length < MAX_WINDOWS_PER_FILE) {
        windows.push({ start, end });
      }
    }

    // Related files can be useful even when they contain no query term (for example, an import).
    if (windows.length === 0 && lines.length > 0)
      windows.push({ start: 0, end: Math.min(17, lines.length - 1) });
    windows.sort((left, right) => left.start - right.start);

    let output = "";
    for (const window of windows) {
      const numbered = lines
        .slice(window.start, window.end + 1)
        .map((line, offset) => `${window.start + offset + 1}: ${this.limitLine(line)}`)
        .join("\n");
      const block = `${output ? "\n…\n" : ""}${path}:${window.start + 1}-${window.end + 1}\n${numbered}`;
      if (output.length + block.length > budget) {
        const available = budget - output.length;
        if (available > path.length + 16) output += block.slice(0, available).trimEnd();
        break;
      }
      output += block;
    }
    return output;
  }

  private lineScore(line: string, queryTerms: string[]): number {
    if (!line.trim()) return 0;
    const words = new Set(this.terms(line));
    return queryTerms.reduce((score, term) => score + (words.has(term) ? 1 : 0), 0);
  }

  private terms(value: string): string[] {
    return [
      ...new Set(
        [value, value.replace(/([a-z])([A-Z])/g, "$1 $2")]
          .flatMap((part) => part.toLowerCase().split(/[^a-z0-9_$]+/))
          .filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
      ),
    ].slice(0, 100);
  }

  private limitLine(line: string): string {
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  }
}
