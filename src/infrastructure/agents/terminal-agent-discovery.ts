import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  NativeAgentSession,
  TerminalAgentInfo,
  TerminalLaunch,
} from "../../domain/terminal-agent.js";
import {
  agentDefinition,
  canResumeAgent,
  nativeResumeArgs,
  terminalAgentCatalog,
} from "./terminal-agent-catalog.js";

const execute = promisify(execFile);
/** Obtain only PATH, including shell-managed Node/CLI installs when launched through Finder. */
async function loginPath(): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const shell = process.env.SHELL || "/bin/zsh";
  if (!isAbsolute(shell)) return undefined;
  try {
    const { stdout } = await execute(shell, ["-lic", 'printf "\\n__KAIRO_PATH__%s\\n" "$PATH"'], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 128_000,
    });
    return stdout
      .split("\n")
      .findLast((line) => line.startsWith("__KAIRO_PATH__"))
      ?.slice(14);
  } catch {
    return undefined;
  }
}

export class TerminalAgentDiscovery {
  private pathPromise?: Promise<string>;
  private refreshPromise?: Promise<TerminalAgentInfo[]>;
  constructor(
    private readonly options: {
      path?: string;
      home?: string;
      hydratePath?: () => Promise<string | undefined>;
    } = {},
  ) {}
  private environmentPath(): Promise<string> {
    return (this.pathPromise ??= (async () => {
      const inherited = this.options.path ?? process.env.PATH ?? "";
      const hydrated =
        this.options.path === undefined
          ? await (this.options.hydratePath ?? loginPath)()
          : undefined;
      const home = this.options.home ?? homedir();
      const dirs = [
        ...inherited.split(delimiter),
        ...(hydrated ?? "").split(delimiter),
        join(home, ".local/bin"),
        join(home, ".opencode/bin"),
        join(home, ".npm-global/bin"),
        join(home, ".cargo/bin"),
        join(home, ".bun/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
      ];
      return [...new Set(dirs.filter(isAbsolute))].join(delimiter);
    })());
  }
  private async executable(command: string): Promise<string | undefined> {
    const path = await this.environmentPath();
    const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const directory of path.split(delimiter)) {
      for (const suffix of suffixes) {
        const candidate = join(directory, command + suffix);
        try {
          if (!(await stat(candidate)).isFile()) continue;
          await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
          return candidate;
        } catch {
          /* Continue to another directory or extension. */
        }
      }
    }
    return undefined;
  }
  /** Refreshes at creation time, never treating the last detection as permission to launch. */
  async refresh(): Promise<TerminalAgentInfo[]> {
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.detect();
    this.refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    }
  }
  private async detect(): Promise<TerminalAgentInfo[]> {
    const commands = [
      ...new Set(
        terminalAgentCatalog.flatMap((agent) => [
          ...agent.commands,
          ...(agent.requiredCommands ?? []),
        ]),
      ),
    ];
    const found = new Map(
      await Promise.all(
        commands.map(async (command) => [command, await this.executable(command)] as const),
      ),
    );
    return terminalAgentCatalog.map((agent) => {
      const executable = agent.commands.map((command) => found.get(command)).find(Boolean);
      const missing = (agent.requiredCommands ?? []).filter((command) => !found.get(command));
      const installed = !!executable && missing.length === 0;
      return {
        ...agent,
        installed,
        executable: installed ? executable : undefined,
        resumable: canResumeAgent(agent.id),
        unavailableReason: installed
          ? undefined
          : missing.length
            ? `Also requires ${missing.join(", ")}.`
            : `Install ${agent.name} and refresh agents.`,
      };
    });
  }
  async launch(
    id: string,
    sessionId: string,
    nativeSession?: NativeAgentSession,
  ): Promise<TerminalLaunch> {
    const definition = agentDefinition(id);
    const detected = (await this.refresh()).find((agent) => agent.id === id)!;
    if (!detected.installed || !detected.executable) throw new Error(detected.unavailableReason);
    return {
      executable: detected.executable,
      args: [...definition.args, ...(nativeSession ? nativeResumeArgs(id, nativeSession) : [])],
      env: { ...definition.env, PATH: await this.environmentPath() },
      title: definition.name,
      sessionId,
    };
  }
}
