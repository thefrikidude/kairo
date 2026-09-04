import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ToolCall, ToolResult } from "../../domain/models.js";
import type { ToolDefinition, ToolExecutor } from "../../domain/ports.js";

const MAX_OUTPUT = 48_000;
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".kairo"]);
const truncate = (value: string) =>
  value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n[output truncated]` : value;

export const definitions: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List workspace files under an optional directory.",
    mutating: false,
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file in the workspace.",
    mutating: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file_range",
    description: "Read a bounded inclusive line range from a UTF-8 workspace file.",
    mutating: false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path", "startLine", "endLine"],
    },
  },
  {
    name: "search_files",
    description: "Search UTF-8 workspace files for literal text.",
    mutating: false,
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, path: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description: "Create or replace a UTF-8 workspace file.",
    mutating: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact text occurrence in a workspace file.",
    mutating: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command inside the workspace.",
    mutating: true,
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

export class WorkspaceTools implements ToolExecutor {
  readonly root: string;
  /** Stores the already-resolved workspace root used for every safety check. */
  private constructor(root: string) {
    this.root = root;
  }
  /** Resolves the requested workspace once before exposing any file tools. */
  static async create(workspace: string): Promise<WorkspaceTools> {
    return new WorkspaceTools(await realpath(workspace));
  }
  /** Returns whether an absolute path remains inside the resolved workspace root. */
  private inside(path: string): boolean {
    const rel = relative(this.root, path);
    return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
  }
  /** Validates a user path and rejects traversal or symlink escapes before access. */
  private async filePath(input: unknown, forWrite = false): Promise<string> {
    if (typeof input !== "string" || !input.trim())
      throw new Error("A non-empty path is required.");
    const candidate = resolve(this.root, input);
    if (!this.inside(candidate)) throw new Error("Path is outside the workspace.");
    try {
      const actual = await realpath(candidate);
      // Resolving first catches a path that looks local but exits through a symlink.
      if (!this.inside(actual)) throw new Error("Symlink escapes the workspace.");
      return actual;
    } catch (error: unknown) {
      if (!forWrite || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await realpath(dirname(candidate));
      if (!this.inside(parent)) throw new Error("Parent directory escapes the workspace.");
      return candidate;
    }
  }
  /** Produces the exact action text shown in the terminal approval prompt. */
  description(call: ToolCall): string {
    return call.name === "run_command"
      ? `Run command in ${this.root}:\n${String(call.args.command ?? "")}`
      : `${call.name}: ${String(call.args.path ?? "workspace")}`;
  }
  /** Dispatches a validated tool request and converts executor errors into tool results. */
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case "list_files":
          return {
            ok: true,
            output: await this.list(await this.filePath(call.args.path ?? ".")),
          };
        case "read_file":
          return {
            ok: true,
            output: truncate(await readFile(await this.filePath(call.args.path), "utf8")),
          };
        case "read_file_range":
          return {
            ok: true,
            output: await this.readRange(call.args),
          };
        case "search_files":
          return {
            ok: true,
            output: await this.search(
              String(call.args.query ?? ""),
              await this.filePath(call.args.path ?? "."),
            ),
          };
        case "write_file": {
          const path = await this.filePath(call.args.path, true);
          if (typeof call.args.content !== "string") throw new Error("content must be a string");
          await writeFile(path, call.args.content, "utf8");
          return { ok: true, output: `Wrote ${relative(this.root, path)}` };
        }
        case "edit_file":
          return await this.edit(call.args);
        case "run_command":
          return await this.command(String(call.args.command ?? ""));
        default:
          throw new Error(`Unknown tool: ${call.name}`);
      }
    } catch (error) {
      return { ok: false, output: `Tool error: ${(error as Error).message}` };
    }
  }
  /** Recursively lists a bounded set of non-ignored workspace files. */
  private async list(dir: string): Promise<string> {
    const out: string[] = [];
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = resolve(current, entry.name);
        const display = relative(this.root, full);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) out.push(display);
        if (out.length >= 500) return;
      }
    };
    await visit(dir);
    return out.length ? truncate(out.sort().join("\n")) : "No files found.";
  }
  /** Searches readable workspace files for a literal query with bounded matches. */
  private async search(query: string, dir: string): Promise<string> {
    if (!query) throw new Error("query cannot be empty");
    const files = (await this.list(dir)).split("\n");
    const matches: string[] = [];
    for (const file of files) {
      if (file.startsWith("[") || matches.length >= 200) break;
      try {
        const text = await readFile(resolve(this.root, file), "utf8");
        text.split("\n").forEach((line, index) => {
          if (line.includes(query) && matches.length < 200)
            matches.push(`${file}:${index + 1}: ${line}`);
        });
      } catch {
        /* binary/unreadable files are skipped */
      }
    }
    return matches.length ? truncate(matches.join("\n")) : "No matches found.";
  }
  /** Returns an inclusive, line-numbered slice while enforcing a small read limit. */
  private async readRange(args: Record<string, unknown>): Promise<string> {
    const { startLine, endLine } = args;
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      (startLine as number) < 1 ||
      (endLine as number) < (startLine as number) ||
      (endLine as number) - (startLine as number) >= 500
    )
      throw new Error("Use an inclusive line range from 1 to at most 500 lines.");
    const lines = (await readFile(await this.filePath(args.path), "utf8")).split("\n");
    const start = startLine as number;
    const selected = lines.slice(start - 1, endLine as number);
    return selected.length
      ? truncate(selected.map((line, index) => `${start + index}: ${line}`).join("\n"))
      : "No lines found in this range.";
  }
  /** Replaces one unambiguous text occurrence in a workspace file. */
  private async edit(args: Record<string, unknown>): Promise<ToolResult> {
    const path = await this.filePath(args.path, true);
    if (typeof args.oldText !== "string" || typeof args.newText !== "string")
      throw new Error("oldText and newText must be strings");
    const text = await readFile(path, "utf8");
    const first = text.indexOf(args.oldText);
    if (first < 0) throw new Error("oldText was not found");
    if (text.indexOf(args.oldText, first + args.oldText.length) >= 0)
      throw new Error("oldText is ambiguous; provide more context");
    await writeFile(path, text.replace(args.oldText, args.newText), "utf8");
    return { ok: true, output: `Edited ${relative(this.root, path)}` };
  }
  /** Runs a shell command in the workspace and captures bounded output and timing. */
  private command(command: string): Promise<ToolResult> {
    if (!command.trim()) return Promise.resolve({ ok: false, output: "command cannot be empty" });
    return new Promise((done) => {
      const startedAt = Date.now();
      const child = spawn(command, {
        cwd: this.root,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = truncate(output + chunk.toString());
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({
          ok: code === 0,
          output: truncate(output || `Command exited with ${code}`),
          exitCode: code,
          durationMs: Date.now() - startedAt,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        done({
          ok: false,
          output: error.message,
          exitCode: null,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
