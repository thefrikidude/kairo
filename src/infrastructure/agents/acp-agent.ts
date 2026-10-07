import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExternalAgentAdapter,
  ExternalAgentInfo,
  ExternalRun,
} from "../../domain/agent-runtime.js";
import { findAgentExecutable } from "./executable.js";
import { JsonRpcProcess, type RpcMessage } from "./json-rpc-process.js";

const exec = promisify(execFile);
type Setup = {
  protocolVersion: number;
  agentCapabilities?: { loadSession?: boolean };
};
type Session = {
  sessionId: string;
  modes?: { availableModes: { id: string; name: string }[] };
};

/** ACP engines execute their own tools; only permission callbacks are handled by Kairo.
 * No client filesystem/terminal capability is advertised, and no credentials are copied.
 */
export class AcpAgentAdapter implements ExternalAgentAdapter {
  private readonly processes = new Set<JsonRpcProcess>();
  private closed = false;
  constructor(
    readonly id: "claude" | "opencode",
    readonly name: string,
    private readonly command?: { executable: string; args: string[] },
  ) {}

  private async executable(): Promise<string | undefined> {
    if (this.command) return Promise.resolve(this.command.executable);
    return findAgentExecutable(this.id === "claude" ? "claude-agent-acp" : "opencode");
  }

  async inspect(): Promise<ExternalAgentInfo> {
    const executable = await this.executable();
    const info: ExternalAgentInfo = {
      id: this.id,
      name: this.name,
      installed: Boolean(executable),
      authenticated: false,
      models: [],
    };
    if (!executable) {
      info.error =
        this.id === "claude"
          ? "Install Claude Code and its ACP bridge: npm install -g @agentclientprotocol/claude-agent-acp. Then sign in with claude auth login."
          : "Install OpenCode, configure a provider with opencode auth login, then refresh agents.";
      return info;
    }
    try {
      const cli = await findAgentExecutable(this.id === "claude" ? "claude" : "opencode");
      if (!cli) throw new Error(`${this.name} CLI is not installed.`);
      const { stdout } = await exec(
        cli,
        this.id === "claude" ? ["auth", "status"] : ["auth", "list"],
        { timeout: 10_000, maxBuffer: 256 * 1024 },
      );
      if (this.id === "claude") {
        const status = JSON.parse(stdout) as { loggedIn?: boolean };
        info.authenticated = status.loggedIn === true;
      } else {
        const output = stdout.replace(/\u001b\[[0-9;]*m/g, "");
        info.authenticated =
          /[1-9]\d* credentials?\b/i.test(output) ||
          /[1-9]\d* environment variables?\b/i.test(output);
      }
      if (!info.authenticated)
        info.error = `Sign in or configure a provider with ${this.id === "claude" ? "claude auth login" : "opencode auth login"}, then refresh agents.`;
    } catch {
      info.error = `Could not confirm ${this.name} authentication. Check ${this.id === "claude" ? "claude auth status" : "opencode auth list"} in your terminal, then refresh agents.`;
    }
    return info;
  }

  async login(): Promise<{ url: string }> {
    throw new Error(
      `Run ${this.id === "claude" ? "claude auth login" : "opencode auth login"} in your terminal, then refresh agents in Kairo.`,
    );
  }

  async run(input: ExternalRun): Promise<"complete" | "cancelled"> {
    if (this.closed) throw new Error(`${this.name} adapter is closed.`);
    if (input.signal.aborted) return "cancelled";
    const executable = await this.executable();
    if (!executable)
      throw new Error(
        `${this.name} ACP executable is unavailable. Refresh agents for setup instructions.`,
      );
    if (input.signal.aborted) return "cancelled";
    if (this.closed) throw new Error(`${this.name} adapter is closed.`);
    const rpc = new JsonRpcProcess(
      executable,
      this.command?.args ?? (this.id === "opencode" ? ["acp"] : []),
      true,
    );
    this.processes.add(rpc);
    let sessionId: string | undefined;
    let acceptingUpdates = false;
    let protocolError: Error | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const toolNames = new Map<string, string>();
    const toolStates = new Map<string, string>();
    const cancel = () => {
      if (sessionId) {
        try {
          rpc.send({ method: "session/cancel", params: { sessionId } });
        } catch {
          /* already closed */
        }
      }
      cancelTimer ??= setTimeout(() => void rpc.close(), 10_000);
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    const receive = async (message: RpcMessage): Promise<void> => {
      const params = message.params ?? {};
      if (message.id !== undefined && message.method) {
        if (
          message.method !== "session/request_permission" ||
          params.sessionId !== sessionId ||
          !acceptingUpdates
        ) {
          rpc.send({
            id: message.id,
            error: { code: -32601, message: "Unsupported or inactive Kairo client request." },
          });
          protocolError = new Error(
            `${this.name} requested an unsupported or inactive Kairo operation: ${message.method}.`,
          );
          await rpc.close();
          return;
        }
        const tool = params.toolCall as { title?: string; rawInput?: unknown } | undefined;
        const options = params.options as { optionId: string; kind: string }[] | undefined;
        const allow = options?.find((option) => option.kind === "allow_once");
        const reject = options?.find((option) => option.kind === "reject_once");
        let releaseAbort = () => {};
        const cancelled = new Promise<boolean>((resolve) => {
          const abort = () => resolve(false);
          input.signal.addEventListener("abort", abort, { once: true });
          releaseAbort = () => input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) abort();
        });
        let approved = false;
        try {
          approved =
            !input.signal.aborted &&
            Boolean(allow) &&
            (await Promise.race([
              input.approve(
                tool?.title ?? "Agent operation",
                JSON.stringify(tool?.rawInput ?? tool ?? {}).slice(0, 12_000),
              ),
              cancelled,
            ]));
        } finally {
          releaseAbort();
        }
        const option = approved ? allow : reject;
        rpc.send({
          id: message.id,
          result: {
            outcome:
              input.signal.aborted || !option
                ? { outcome: "cancelled" }
                : { outcome: "selected", optionId: option.optionId },
          },
        });
        return;
      }
      if (
        message.method !== "session/update" ||
        params.sessionId !== sessionId ||
        !acceptingUpdates
      )
        return;
      const update = params.update as {
        sessionUpdate: string;
        content?: { type?: string; text?: string };
        toolCallId?: string;
        title?: string;
        kind?: string;
        status?: string;
      };
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
        input.onText(update.content.text ?? "");
      else if (
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.toolCallId
      ) {
        const id = update.toolCallId;
        if (update.title || update.kind) toolNames.set(id, update.title ?? update.kind!);
        const status = update.status ?? "pending";
        if (!toolStates.has(id)) input.onTool(id, toolNames.get(id) ?? "Agent operation", false);
        if (toolStates.get(id) !== status && ["completed", "failed"].includes(status))
          input.onTool(
            id,
            toolNames.get(id) ?? "Agent operation",
            true,
            status === "completed" ? "succeeded" : "failed",
          );
        toolStates.set(id, status);
      }
    };
    rpc.onMessage((message) => {
      void receive(message).catch(() => void rpc.close());
    });
    try {
      const setup = await rpc.request<Setup>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "kairo", version: "0.1.2" },
      });
      if (setup.protocolVersion !== 1)
        throw new Error(`${this.name} requires an unsupported ACP version.`);
      if (input.signal.aborted) return "cancelled";
      let session: Session;
      let fresh = true;
      if (input.threadId && setup.agentCapabilities?.loadSession) {
        try {
          const loaded = await rpc.request<Omit<Session, "sessionId">>("session/load", {
            sessionId: input.threadId,
            cwd: input.workspace,
            mcpServers: [],
          });
          session = { ...loaded, sessionId: input.threadId };
          fresh = false;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/session.*(not found|unknown|missing)|not found.*session/i.test(error.message)
          )
            throw error;
          session = await rpc.request<Session>("session/new", {
            cwd: input.workspace,
            mcpServers: [],
          });
          input.onText(
            "Saved agent history is unavailable. Continuing in a fresh session with Kairo's task handoff.\n\n",
          );
        }
      } else
        session = await rpc.request<Session>("session/new", {
          cwd: input.workspace,
          mcpServers: [],
        });
      sessionId = session.sessionId;
      if (!sessionId) throw new Error(`${this.name} did not return an ACP session ID.`);
      input.onThread(sessionId);
      if (input.signal.aborted) {
        cancel();
        return "cancelled";
      }
      if (input.model)
        throw new Error(
          "Model selection for this ACP adapter is not yet supported. Use the agent's configured default.",
        );
      const modes = session.modes?.availableModes ?? [];
      const selectedMode =
        input.mode === "plan"
          ? modes.find((mode) => mode.id === "plan")
          : modes.find((mode) => ["build", "default", "code"].includes(mode.id));
      if (input.mode === "plan" && !selectedMode)
        throw new Error(`${this.name} does not advertise a Plan mode.`);
      if (selectedMode)
        await rpc.request("session/set_mode", { sessionId, modeId: selectedMode.id });
      if (input.signal.aborted) {
        cancel();
        return "cancelled";
      }
      acceptingUpdates = true;
      const text =
        fresh && input.context
          ? `${input.context}\n\nLatest user request:\n${input.prompt}`
          : input.prompt;
      const result = await rpc.request<{ stopReason: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        0,
      );
      if (input.signal.aborted || result.stopReason === "cancelled") return "cancelled";
      if (result.stopReason !== "end_turn")
        throw new Error(`${this.name} stopped before completion: ${result.stopReason}.`);
      return "complete";
    } catch (error) {
      if (input.signal.aborted) return "cancelled";
      throw protocolError ?? error;
    } finally {
      acceptingUpdates = false;
      clearTimeout(cancelTimer);
      input.signal.removeEventListener("abort", cancel);
      for (const [id, status] of toolStates) {
        if (!["completed", "failed"].includes(status))
          input.onTool(id, toolNames.get(id) ?? "Agent operation", true, "failed");
      }
      // Own a process per run: stopping it cannot terminate another chat's agent.
      await rpc.close();
      this.processes.delete(rpc);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.processes].map((rpc) => rpc.close()));
  }
}
