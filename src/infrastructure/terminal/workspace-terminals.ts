import type { TerminalLaunch } from "../../domain/terminal-agent.js";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { IPty } from "node-pty";
import type {
  TerminalData,
  TerminalSnapshot,
  WorkspaceTerminal,
} from "../../domain/workspace-terminal.js";
import {
  stopTerminalTree,
  terminalProcesses,
  sameProcess,
  TerminalCleanupError,
  type TerminalProcess,
} from "./terminal-processes.js";

type Record = {
  info: WorkspaceTerminal;
  pty: IPty;
  buffer: string;
  sequence: number;
  subscribed: boolean;
  pending: { sequence: number; size: number }[];
  queued: string;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  exit: Promise<void>;
  resolveExit(): void;
  disposers: { dispose(): void }[];
  paused: boolean;
  cleanupFailed: boolean;
  remainingProcesses: TerminalProcess[];
};
const scrollbackLimit = 128_000;
const flowLimit = 128_000;

/** Quote literal argv for an interactive Unix shell, never interpret agent arguments as code. */
function startupCommand(launch: TerminalLaunch): string {
  const words = [launch.executable, ...launch.args];
  if (words.some((word) => /[\x00-\x1f\x7f]/.test(word)))
    throw new Error("Agent commands cannot contain terminal control characters.");
  const command = words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  // Stay below the terminal's canonical input-line limit, measured in bytes.
  if (Buffer.byteLength(command) > 4_000) throw new Error("Agent startup command is too long.");
  return command;
}

/** Lazy native PTYs with bounded replay and renderer acknowledgements, independent of agent adapters. */
export class WorkspaceTerminals {
  private records = new Map<string, Record>();
  private closed = false;
  private creating = new Map<string, Promise<WorkspaceTerminal>>();
  private pendingCreates = new Set<Promise<WorkspaceTerminal>>();
  constructor(
    private readonly emit: (event: string, payload: unknown) => void,
    private readonly options: { shell?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {},
  ) {}
  beginClose(): void {
    this.closed = true;
  }
  list(workspaceId?: string): WorkspaceTerminal[] {
    return [...this.records.values()]
      .filter((record) => !workspaceId || record.info.workspaceId === workspaceId)
      .map((record) => ({ ...record.info }));
  }
  hasProcesses(directory: string, overlaps: (a: string, b: string) => boolean): boolean {
    return [...this.records.values()].some(
      (record) =>
        overlaps(directory, record.info.directory) &&
        (record.info.state === "running" || record.closing || record.cleanupFailed),
    );
  }
  async create(workspaceId: string, directory: string, reuse = false): Promise<WorkspaceTerminal> {
    if (this.closed) throw new Error("Kairo is shutting down.");
    if (reuse) {
      const existing = this.list(workspaceId).find((terminal) => !terminal.sessionId);
      if (existing) return existing;
      const pending = this.creating.get(workspaceId);
      if (pending) return pending;
    }
    const pending = this.spawn(workspaceId, directory);
    this.pendingCreates.add(pending);
    if (reuse) this.creating.set(workspaceId, pending);
    try {
      return await pending;
    } finally {
      this.pendingCreates.delete(pending);
      if (this.creating.get(workspaceId) === pending) this.creating.delete(workspaceId);
    }
  }
  /** A session owns a normal shell; its agent runs as a foreground shell job. */
  async createAgent(
    workspaceId: string,
    directory: string,
    launch: TerminalLaunch,
  ): Promise<WorkspaceTerminal> {
    if (this.closed) throw new Error("Kairo is shutting down.");
    if (!launch.sessionId) throw new Error("Agent terminals require a session identity.");
    const existing = this.list(workspaceId).find(
      (terminal) => terminal.sessionId === launch.sessionId,
    );
    if (existing) return existing;
    const key = `agent:${launch.sessionId}`;
    const creating = this.creating.get(key);
    if (creating) return creating;
    const pending = this.spawn(workspaceId, directory, launch);
    this.creating.set(key, pending);
    this.pendingCreates.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingCreates.delete(pending);
      if (this.creating.get(key) === pending) this.creating.delete(key);
    }
  }
  private async spawn(
    workspaceId: string,
    requested: string,
    launch?: TerminalLaunch,
  ): Promise<WorkspaceTerminal> {
    const directory = await realpath(requested);
    if (!(await stat(directory)).isDirectory())
      throw new Error("This workspace folder is unavailable.");
    const native = await import("node-pty");
    if (this.closed) throw new Error("Kairo is shutting down.");
    if (this.records.size >= 20)
      throw new Error("Close an unused terminal before opening another (20 terminal limit).");
    const shell =
      this.options.shell ??
      (process.platform === "win32"
        ? process.env.COMSPEC || "cmd.exe"
        : process.env.SHELL || "/bin/zsh");
    if (launch && process.platform === "win32")
      throw new Error("Agent shell sessions currently require macOS or Linux.");
    const command = launch ? startupCommand(launch) : undefined;
    const pty = native.spawn(
      shell,
      this.options.args ?? (process.platform === "win32" ? [] : ["-l", "-i"]),
      {
        name: "xterm-256color",
        cwd: directory,
        cols: 80,
        rows: 24,
        env: { ...process.env, ...this.options.env, ...launch?.env, TERM: "xterm-256color" },
      },
    );
    let resolveExit!: () => void;
    const record: Record = {
      info: {
        id: randomUUID(),
        workspaceId,
        directory,
        title: launch?.title ?? basename(shell),
        sessionId: launch?.sessionId,
        pid: pty.pid,
        state: "running",
        columns: 80,
        rows: 24,
      },
      pty,
      buffer: "",
      sequence: 0,
      subscribed: false,
      queued: "",
      pending: [],
      exit: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      resolveExit,
      disposers: [],
      paused: false,
      cleanupFailed: false,
      remainingProcesses: [],
    };
    this.records.set(record.info.id, record);
    record.disposers.push(
      pty.onData((data) => {
        record.buffer = (record.buffer + data).slice(-scrollbackLimit);
        if (record.subscribed) {
          record.queued += data;
          if (record.queued.length >= 64_000) this.flush(record);
          else if (!record.timer) record.timer = setTimeout(() => this.flush(record), 16);
        } else record.sequence += 1;
      }),
      pty.onExit(({ exitCode }) => {
        this.flush(record);
        record.info.state = "exited";
        record.info.exitCode = exitCode;
        record.resolveExit();
        this.emit("terminal:state", { ...record.info });
      }),
    );
    // Queue ordinary terminal input, just as a user types a command. The shell
    // retains job control, its environment and cwd after the foreground CLI exits.
    const shellName = basename(shell);
    const prompt =
      this.options.env?.PS1 || this.options.env?.PROMPT
        ? ""
        : shellName === "zsh"
          ? "PROMPT='%/ %# '; "
          : ["bash", "sh"].includes(shellName)
            ? "PS1='\\w\\$ '; "
            : "";
    if (prompt || command) pty.write(`${prompt}${command ?? ""}\r`);
    this.emit("terminal:state", { ...record.info });
    return { ...record.info };
  }
  private get(id: string): Record {
    const record = this.records.get(id);
    if (!record) throw new Error("This terminal was closed. Open a new terminal.");
    return record;
  }
  private flush(record: Record): void {
    clearTimeout(record.timer);
    record.timer = undefined;
    if (!record.queued) return;
    const data = record.queued;
    record.queued = "";
    const sequence = ++record.sequence;
    if (!record.subscribed) return;
    record.pending.push({ sequence, size: data.length });
    if (
      !record.paused &&
      record.pending.reduce((size, packet) => size + packet.size, 0) >= flowLimit &&
      record.info.state === "running"
    ) {
      record.pty.pause();
      record.paused = true;
    }
    this.emit("terminal:data", {
      id: record.info.id,
      workspaceId: record.info.workspaceId,
      data,
      sequence,
    } satisfies TerminalData);
  }
  attach(id: string): TerminalSnapshot {
    const record = this.get(id);
    this.flush(record);
    record.subscribed = true;
    record.pending = [];
    if (record.paused) {
      record.pty.resume();
      record.paused = false;
    }
    return { ...record.info, buffer: record.buffer, sequence: record.sequence };
  }
  detach(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.subscribed = false;
    record.pending = [];
    record.queued = "";
    clearTimeout(record.timer);
    record.timer = undefined;
    if (record.paused && record.info.state === "running") record.pty.resume();
    record.paused = false;
  }
  acknowledge(id: string, sequence: unknown): void {
    const record = this.records.get(id);
    if (!record?.subscribed) return;
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > record.sequence
    )
      throw new Error("Invalid terminal output acknowledgement.");
    record.pending = record.pending.filter((packet) => packet.sequence > sequence);
    if (
      record.paused &&
      record.pending.reduce((size, packet) => size + packet.size, 0) < flowLimit / 2 &&
      record.info.state === "running"
    ) {
      record.pty.resume();
      record.paused = false;
    }
  }
  input(id: string, data: unknown): void {
    const record = this.get(id);
    if (record.info.state !== "running")
      throw new Error("This terminal has exited. Open a new terminal.");
    if (typeof data !== "string" || data.length > 32_000)
      throw new Error("Terminal input must contain at most 32,000 characters.");
    record.pty.write(data);
  }
  resize(id: string, columns: unknown, rows: unknown): void {
    const record = this.get(id);
    if (
      typeof columns !== "number" ||
      typeof rows !== "number" ||
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      columns < 2 ||
      rows < 2 ||
      columns > 500 ||
      rows > 200
    )
      throw new Error("Invalid terminal dimensions.");
    if (
      record.info.state === "running" &&
      (record.info.columns !== columns || record.info.rows !== rows)
    )
      record.pty.resize(columns, rows);
    record.info.columns = columns;
    record.info.rows = rows;
  }
  async closeTerminal(id: string): Promise<void> {
    const record = this.get(id);
    if (record.closing) return record.closing;
    const closing = (async () => {
      this.detach(id);
      try {
        if (record.remainingProcesses.length) {
          const current = await terminalProcesses();
          const remaining = record.remainingProcesses.filter((child) =>
            current.some((row) => sameProcess(child, row)),
          );
          if (remaining.length) throw new TerminalCleanupError(remaining);
        }
        await stopTerminalTree(
          record.info.pid,
          () => {
            if (record.info.state === "running") record.pty.kill();
          },
          () => record.info.state === "exited",
        );
        if (record.info.state === "running") {
          await Promise.race([
            record.exit,
            new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
          ]);
          if (record.info.state === "running") {
            record.pty.kill("SIGKILL");
            await Promise.race([
              record.exit,
              new Promise<void>((_, reject) =>
                setTimeout(
                  () => reject(new Error("This terminal did not stop. Try closing it again.")),
                  2_000,
                ),
              ),
            ]);
          }
        }
        for (const disposer of record.disposers) disposer.dispose();
        this.records.delete(id);
        this.emit("terminal:closed", { id, workspaceId: record.info.workspaceId });
      } catch (error) {
        record.cleanupFailed = true;
        if (error instanceof TerminalCleanupError) record.remainingProcesses = error.processes;
        throw error;
      }
    })();
    record.closing = closing;
    try {
      await closing;
    } finally {
      record.closing = undefined;
    }
  }
  async close(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.pendingCreates]);
    const results = await Promise.allSettled(
      [...this.records.keys()].map((id) => this.closeTerminal(id)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
