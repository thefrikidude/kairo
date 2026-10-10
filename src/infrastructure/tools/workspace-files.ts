import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";

export type FileSnapshot = { content: string; revision: string };
export type FileSearch = { paths: string[]; limited: boolean };
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
    const actual = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          "This file or folder is unavailable. Refresh the tree or wait for the agent to create it.",
        );
      throw error;
    });
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
  async snapshot(input: unknown): Promise<FileSnapshot> {
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
        return {
          content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
          revision: createHash("sha256").update(content).digest("hex"),
        };
      } catch {
        throw new Error("This file is not UTF-8 text. Open it in your editor.");
      }
    } finally {
      await handle.close();
    }
  }
  async read(input: unknown): Promise<string> {
    return (await this.snapshot(input)).content;
  }

  async resolveFile(input: unknown): Promise<string> {
    return this.path(input);
  }

  /** Complete-buffer revision check, then atomic replacement; reject external edits rather than overwrite them. */
  async save(input: unknown, content: unknown, expectedRevision: unknown): Promise<FileSnapshot> {
    if (
      typeof content !== "string" ||
      content.includes("\0") ||
      Buffer.byteLength(content, "utf8") > previewLimit
    )
      throw new Error("Edits must be UTF-8 text no larger than 1 MB.");
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))
      throw new Error("Reload this file before saving.");
    const target = await this.path(input);
    const original = await this.snapshot(input);
    if (original.revision !== expectedRevision)
      throw new Error(
        "This file changed outside the editor. Your edits are kept. Reload or copy your edits before trying again.",
      );
    const handle = await open(target, "r");
    const metadata = await handle.stat().finally(() => handle.close());
    if (metadata.nlink > 1)
      throw new Error("This file has multiple hard links. Edit it in your external editor.");
    const temporary = resolve(dirname(target), `.${basename(target)}.kairo-${randomUUID()}`);
    try {
      const output = await open(temporary, "wx", metadata.mode & 0o777);
      try {
        await output.writeFile(content, "utf8");
        await output.chmod(metadata.mode & 0o777);
        await output.sync();
      } finally {
        await output.close();
      }
      if (
        (await this.path(input)) !== target ||
        (await this.snapshot(input)).revision !== expectedRevision
      )
        throw new Error(
          "This file changed while saving. Your edits are kept; reload or copy them before trying again.",
        );
      await rename(temporary, target);
      return { content, revision: createHash("sha256").update(content, "utf8").digest("hex") };
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /** Filename search runs on explicit queries only, with a Git fast path and bounded folder fallback. */
  async search(input: unknown): Promise<FileSearch> {
    if (typeof input !== "string" || !input.trim()) return { paths: [], limited: false };
    const query = input.trim().toLowerCase();
    try {
      const git = process.platform === "darwin" ? "/usr/bin/git" : "git";
      const output = (
        await promisify(execFile)(
          git,
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
          {
            cwd: this.root,
            encoding: "utf8",
            timeout: 3_000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
        )
      ).stdout;
      const matches = [
        ...new Set(output.split("\0").filter((path) => path && path.toLowerCase().includes(query))),
      ];
      return { paths: matches.slice(0, 100), limited: matches.length > 100 };
    } catch (error) {
      if (!(error as { stderr?: string }).stderr?.includes("not a git repository"))
        throw new Error(
          "File search could not finish. Browse a folder or narrow your project scope.",
        );
    }
    const paths: string[] = [];
    const pending = ["."];
    let scanned = 0;
    const deadline = Date.now() + 1_000;
    while (pending.length && paths.length < 100 && scanned < 15_000 && Date.now() < deadline) {
      for (const entry of await this.directory(pending.shift())) {
        scanned += 1;
        if (entry.kind === "directory") pending.push(entry.path);
        else if (entry.path.toLowerCase().includes(query)) paths.push(entry.path);
        if (paths.length >= 100 || scanned >= 15_000) break;
      }
    }
    return { paths, limited: pending.length > 0 || paths.length >= 100 || scanned >= 15_000 };
  }
}
