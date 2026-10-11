import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { stopTerminalTree } from "../terminal/terminal-processes.js";
const execute = promisify(execFile);

export function literalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    /[*?\[\]!]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("Copy paths must be literal relative paths without symlinks or traversal.");
  return value;
}

/** Copies are exclusive and journaled individually so retries preserve already copied files. */
export async function copyWorkspacePaths(
  source: string,
  destination: string,
  paths: string[],
  copied: string[],
  signal: AbortSignal,
  record: (path: string) => void,
): Promise<void> {
  source = await realpath(source);
  destination = await realpath(destination);
  let files = 0;
  let bytes = 0;
  const inspect = async (root: string, path: string) => {
    let current = root;
    for (const segment of path.split("/")) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Cannot copy symlink: ${path}`);
    }
    const actual = await realpath(current);
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`Copy path escapes checkout: ${path}`);
    return lstat(current);
  };
  const copy = async (path: string) => {
    signal.throwIfAborted();
    const info = await inspect(source, path);
    if (info.isDirectory()) {
      try {
        await inspect(destination, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(join(destination, path), { recursive: true });
      }
      for (const entry of await readdir(join(source, path))) await copy(`${path}/${entry}`);
      return;
    }
    if (!info.isFile()) throw new Error(`Cannot copy non-file: ${path}`);
    if (++files > 10_000 || (bytes += info.size) > 256 * 1024 * 1024)
      throw new Error(
        "Local file copying exceeds 10,000 files or 256 MB. Use a setup script instead.",
      );
    if (copied.includes(path)) return;
    const parent = dirname(path);
    if (parent !== ".") {
      try {
        await inspect(destination, parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(join(destination, parent), { recursive: true });
        await inspect(destination, parent);
      }
    }
    await copyFile(join(source, path), join(destination, path), constants.COPYFILE_EXCL);
    record(path);
  };
  for (const value of paths) {
    const path = literalPath(value);
    signal.throwIfAborted();
    await inspect(source, path);
    const { stdout } = await execute("git", ["ls-files", "-z", "--", path], {
      cwd: source,
      signal,
      maxBuffer: 1024 * 1024,
    });
    if (stdout) throw new Error(`Copy path contains tracked files: ${path}`);
    try {
      await execute("git", ["check-ignore", "-q", "--", path], { cwd: source, signal });
    } catch {
      throw new Error(`Copy path is not ignored by Git: ${path}`);
    }
    await copy(path);
  }
}

export async function runWorkspaceSetup(
  script: string,
  source: string,
  destination: string,
  signal: AbortSignal,
  output: (value: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  if (!script.trim()) return;
  if (process.platform === "win32")
    throw new Error("Workspace setup scripts currently require macOS or Linux.");
  const child = spawn("/bin/sh", ["-e", "-c", script], {
    cwd: destination,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KAIRO_SOURCE_DIR: source, KAIRO_WORKSPACE_DIR: destination },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  let exited = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!child.pid) return;
    stopping ??= stopTerminalTree(
      child.pid,
      () => child.kill("SIGKILL"),
      () => exited,
    );
    void stopping.catch(() => {});
  };
  const timer = setTimeout(stop, 10 * 60_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => {
        exited = true;
        done(code);
      });
    });
    if (stopping) await stopping;
    // Setup commands must finish; background servers belong in workspace terminal tabs.
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await new Promise((done) => setTimeout(done, 150));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    signal.throwIfAborted();
    if (code !== 0)
      throw new Error(
        `Setup exited ${code ?? "after termination"}. Open a shell or retry preparation.`,
      );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
