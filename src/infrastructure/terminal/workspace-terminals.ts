import type { TerminalLaunch } from "../../domain/terminal-agent.js";
import { execFile } from "node:child_process";
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
  startedAt: number;
  lastInputAt: number;
  /** Output since the last keystroke; an answered prompt must not count as still waiting. */
  sinceInput: string;
  activityTimer?: ReturnType<typeof setTimeout>;
  cleanupFailed: boolean;
  remainingProcesses: TerminalProcess[];
};
const scrollbackLimit = 128_000;
const flowLimit = 128_000;
// Output this soon after a keystroke is the terminal echoing it, not an agent working.
const echoWindowMs = 400;
// A fresh plain shell prints its prompt and profile output; that is not work either.
const shellStartupMs = 1_500;
const defaultQuietMs = 2_000;
const waitingPrompt =
  /(\[y\/n\]|\(y\/n\)|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|\byes\/no\b|do you want to (proceed|continue|allow|make|create|run)|\ballow (this|once|always)|press (enter|any key)|waiting for (your )?(input|approval|confirmation)|\bapprove\b|\bcontinue\?)/i;
// eslint-disable-next-line no-control-regex
const ansi = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** True when the visible tail of the output looks like the program is asking the user to decide. */
export function asksForInput(buffer: string): boolean {
  const lines = buffer
    .slice(-2_000)
    .replace(ansi, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  return waitingPrompt.test(lines.slice(-4).join("\n"));
}

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

/**
 * The command line of the terminal's foreground job, or undefined while its shell is idle. Asks `ps`
 * for the shell's terminal foreground process group, since agents run as jobs of the shell.
 */
async function foregroundCommand(shellPid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const ps = (args: string[]) =>
    new Promise<string>((resolve) =>
      execFile("ps", args, { timeout: 1_500 }, (error, stdout) =>
        resolve(error ? "" : stdout.trim()),
      ),
    );
  const group = Number(await ps(["-o", "tpgid=", "-p", String(shellPid)]));
  if (!Number.isInteger(group) || group <= 0 || group === shellPid) return undefined;
  const command = await ps(["-o", "args=", "-p", String(group)]);
  return command ? command.slice(0, 300) : undefined;
}

/** Lazy native PTYs with bounded replay and renderer acknowledgements, independent of agent adapters. */
export class WorkspaceTerminals {
  private records = new Map<string, Record>();
  private closed = false;
  private creating = new Map<string, Promise<WorkspaceTerminal>>();
  private pendingCreates = new Set<Promise<WorkspaceTerminal>>();
  private foregroundTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  constructor(
    private readonly emit: (event: string, payload: unknown) => void,
    private readonly options: {
      shell?: string;
      args?: string[];
      env?: NodeJS.ProcessEnv;
      quietMs?: number;
      /** How often to look at each terminal's foreground command. */
      foregroundPollMs?: number;
    } = {},
  ) {}
  beginClose(): void {
    this.closed = true;
  }
  list(workspaceId?: string): WorkspaceTerminal[] {
    return [...this.records.values()]
      .filter((record) => !workspaceId || record.info.workspaceId === workspaceId)
      .map((record) => ({ ...record.info }));
  }
  rename(id: string, title: string): WorkspaceTerminal {
    const record = this.records.get(id);
    if (!record) throw new Error("That terminal is no longer open.");
    const next = title.trim().slice(0, 200);
    if (!next) throw new Error("Enter a name for the terminal.");
    record.info.title = next;
    record.info.named = true;
    this.emit("terminal:state", { ...record.info });
    return { ...record.info };
  }
  /** Keeps `foreground` current while any terminal is open, so the UI can tell which agent runs. */
  private watchForeground(): void {
    if (this.foregroundTimer || this.closed) return;
    this.foregroundTimer = setInterval(
      () => void this.pollForeground(),
      this.options.foregroundPollMs ?? 2_000,
    );
    this.foregroundTimer.unref();
  }
  private async pollForeground(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const record of [...this.records.values()]) {
        if (record.info.state !== "running" || record.closing) continue;
        const command = await foregroundCommand(record.pty.pid);
        if (command === record.info.foreground || !this.records.has(record.info.id)) continue;
        record.info.foreground = command;
        this.emit("terminal:state", { ...record.info });
      }
      if (!this.records.size && this.foregroundTimer) {
        clearInterval(this.foregroundTimer);
        this.foregroundTimer = undefined;
      }
    } finally {
      this.polling = false;
    }
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
        activity: "idle",
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
      startedAt: Date.now(),
      lastInputAt: 0,
      sinceInput: "",
      cleanupFailed: false,
      remainingProcesses: [],
    };
    this.records.set(record.info.id, record);
    this.watchForeground();
    record.disposers.push(
      pty.onData((data) => {
        record.buffer = (record.buffer + data).slice(-scrollbackLimit);
        record.sinceInput = (record.sinceInput + data).slice(-2_000);
        this.noteOutput(record);
        if (record.subscribed) {
          record.queued += data;
          if (record.queued.length >= 64_000) this.flush(record);
          else if (!record.timer) record.timer = setTimeout(() => this.flush(record), 16);
        } else record.sequence += 1;
      }),
      pty.onExit(({ exitCode }) => {
        this.flush(record);
        clearTimeout(record.activityTimer);
        record.info.activity = "idle";
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
  private noteOutput(record: Record): void {
    const now = Date.now();
    if (now - record.lastInputAt < echoWindowMs) return;
    if (!record.info.sessionId && now - record.startedAt < shellStartupMs) return;
    this.setActivity(record, "working");
    this.settleWhenQuiet(record);
  }
  private settleWhenQuiet(record: Record): void {
    clearTimeout(record.activityTimer);
    record.activityTimer = setTimeout(() => {
      if (record.info.state !== "running") return;
      this.setActivity(record, asksForInput(record.sinceInput) ? "waiting" : "idle");
    }, this.options.quietMs ?? defaultQuietMs);
  }
  private setActivity(record: Record, activity: WorkspaceTerminal["activity"]): void {
    if (record.info.activity === activity) return;
    record.info.activity = activity;
    this.emit("terminal:state", { ...record.info });
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
    record.lastInputAt = Date.now();
    record.sinceInput = "";
    // Answering a prompt hands control back to the program, so stop showing "waiting".
    if (record.info.activity === "waiting") {
      this.setActivity(record, "working");
      this.settleWhenQuiet(record);
    }
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
      clearTimeout(record.activityTimer);
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
    if (this.foregroundTimer) clearInterval(this.foregroundTimer);
    this.foregroundTimer = undefined;
    await Promise.allSettled([...this.pendingCreates]);
    const results = await Promise.allSettled(
      [...this.records.keys()].map((id) => this.closeTerminal(id)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
