import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceEntry = { path: string; name: string; kind: "directory" | "file" };
const hiddenDirectories = new Set([".git", "node_modules", ".next", ".cache", "coverage"]);
const previewLimit = 1_048_576;

/** Desktop file access is separate from the agent's deliberately truncated tool output. */
export class WorkspaceFiles {
  private constructor(private readonly root: string) {}

  static async create(workspace: string): Promise<WorkspaceFiles> {
    return new WorkspaceFiles(await realpath(workspace));
  }

  private async path(input: unknown): Promise<string> {
    if (typeof input !== "string" || !input.trim()) throw new Error("Choose a file or folder.");
    const candidate = resolve(this.root, input);
    const inside = (path: string) => {
      const rel = relative(this.root, path);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    if (!inside(candidate)) throw new Error("Path is outside the workspace.");
    const actual = await realpath(candidate);
    if (!inside(actual)) throw new Error("Symlink escapes the workspace.");
    return actual;
  }

  /** Reads only one directory; no eager repository-wide tree scan or symlink traversal. */
  async directory(input: unknown = "."): Promise<WorkspaceEntry[]> {
    const dir = await this.path(input);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) => !hiddenDirectories.has(entry.name) && (entry.isDirectory() || entry.isFile()),
      )
      .map((entry): WorkspaceEntry => ({
        name: entry.name,
        path: relative(this.root, resolve(dir, entry.name)).split(sep).join("/"),
        kind: entry.isDirectory() ? "directory" : "file",
      }))
      .sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.name.localeCompare(b.name),
      );
  }

  /** Returns a complete text buffer, or refuses it; never returns silently truncated content. */
  async read(input: unknown): Promise<string> {
    const handle = await open(await this.path(input), "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Choose a regular file.");
      if (metadata.size > previewLimit)
        throw new Error("This file is larger than 1 MB. Open it in your editor.");
      const buffer = Buffer.alloc(previewLimit + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > previewLimit)
        throw new Error("This file is larger than 1 MB. Open it in your editor.");
      const content = buffer.subarray(0, size);
      if (content.includes(0))
        throw new Error("Binary files cannot be previewed. Open this file in your editor.");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        throw new Error("This file is not UTF-8 text. Open it in your editor.");
      }
    } finally {
      await handle.close();
    }
  }
}
