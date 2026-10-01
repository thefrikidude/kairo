import type {
  ExternalAgentAdapter,
  ExternalAgentInfo,
  ExternalRun,
} from "../../domain/agent-runtime.js";
import { findAgentExecutable } from "./executable.js";
import { JsonRpcProcess, type RpcMessage } from "./json-rpc-process.js";

type ThreadResponse = { thread: { id: string } };
type TurnResponse = { turn: { id: string } };
type RunningTurn = {
  input: ExternalRun;
  turnId?: string;
  finish(status: "complete" | "cancelled"): void;
  fail(error: Error): void;
  seenText: Set<string>;
  lastTextItem?: string;
  cancelTimer?: ReturnType<typeof setTimeout>;
};

/** Uses the installed CLI's official app-server protocol and existing account configuration. */
export class CodexAgentAdapter implements ExternalAgentAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  private rpc?: JsonRpcProcess;
  private ready?: Promise<JsonRpcProcess>;
  private running = new Map<string, RunningTurn>();
  private closed = false;

  constructor(private readonly command?: { executable: string; args: string[] }) {}

  private connect(): Promise<JsonRpcProcess> {
    if (this.closed) return Promise.reject(new Error("Codex service is closed."));
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const executable = this.command?.executable ?? (await findAgentExecutable("codex"));
      if (!executable)
        throw new Error(
          "Codex CLI is not installed. Install it using the official Codex instructions, then refresh agents.",
        );
      if (this.closed) throw new Error("Codex service is closed.");
      const rpc = new JsonRpcProcess(
        executable,
        this.command?.args ?? ["app-server", "--listen", "stdio://"],
      );
      this.rpc = rpc;
      rpc.onMessage((message) => this.receive(rpc, message));
      rpc.onExit((error) => {
        for (const turn of this.running.values()) turn.fail(error);
        if (this.rpc === rpc) {
          this.rpc = undefined;
          this.ready = undefined;
        }
      });
      try {
        await rpc.request("initialize", {
          clientInfo: { name: "kairo", title: "Kairo", version: "0.1.2" },
        });
        rpc.send({ method: "initialized" });
        return rpc;
      } catch (error) {
        await rpc.close();
        throw error;
      }
    })();
    void this.ready.catch(() => {
      this.ready = undefined;
    });
    return this.ready;
  }

  async inspect(): Promise<ExternalAgentInfo> {
    const installed = Boolean(this.command || (await findAgentExecutable("codex")));
    const info: ExternalAgentInfo = {
      id: this.id,
      name: this.name,
      installed,
      authenticated: false,
      models: [],
    };
    if (!installed) return info;
    try {
      const rpc = await this.connect();
      const account = await rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>(
        "account/read",
        { refreshToken: false },
      );
      info.authenticated = Boolean(account.account) || account.requiresOpenaiAuth === false;
      let cursor: string | null = null;
      do {
        const page: { data: { model: string; displayName: string }[]; nextCursor?: string | null } =
          await rpc.request("model/list", { limit: 100, cursor, includeHidden: false });
        info.models.push(
          ...page.data.map((model) => ({ id: model.model, label: model.displayName })),
        );
        cursor = page.nextCursor ?? null;
      } while (cursor);
    } catch (error) {
      info.error = error instanceof Error ? error.message : String(error);
    }
    return info;
  }

  async login(): Promise<{ url: string }> {
    const rpc = await this.connect();
    const result = await rpc.request<{ authUrl: string }>("account/login/start", {
      type: "chatgpt",
    });
    if (!result.authUrl) throw new Error("Codex did not return a browser sign-in URL.");
    return { url: result.authUrl };
  }

  async run(input: ExternalRun): Promise<"complete" | "cancelled"> {
    if (input.signal.aborted) return "cancelled";
    const rpc = await this.connect();
    if (input.signal.aborted) return "cancelled";
    const settings = {
      cwd: input.workspace,
      model: input.model ?? null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: input.mode === "plan" ? "read-only" : "workspace-write",
    };
    const thread = input.threadId
      ? await rpc.request<ThreadResponse>("thread/resume", {
          ...settings,
          threadId: input.threadId,
        })
      : await rpc.request<ThreadResponse>("thread/start", settings);
    const threadId = thread.thread.id;
    input.onThread(threadId);
    if (input.signal.aborted) return "cancelled";
    if (this.running.has(threadId))
      throw new Error("A turn is already running in this Codex thread.");
    let resolve!: (state: "complete" | "cancelled") => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<"complete" | "cancelled">((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A transport can fail while turn/start is still awaiting its response.
    void completed.catch(() => {});
    const turn: RunningTurn = { input, finish: resolve, fail: reject, seenText: new Set() };
    this.running.set(threadId, turn);
    const cancel = () => {
      if (!turn.turnId) return;
      void rpc.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(reject);
      turn.cancelTimer ??= setTimeout(() => {
        reject(new Error("Codex did not acknowledge cancellation; its service was stopped."));
        void rpc.close();
      }, 10_000);
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await rpc.request<TurnResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        model: input.model ?? null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy:
          input.mode === "plan"
            ? { type: "readOnly", networkAccess: false }
            : { type: "workspaceWrite", writableRoots: [input.workspace], networkAccess: false },
      });
      turn.turnId = result.turn.id;
      if (input.signal.aborted) cancel();
      return await completed;
    } finally {
      clearTimeout(turn.cancelTimer);
      input.signal.removeEventListener("abort", cancel);
      this.running.delete(threadId);
    }
  }

  private receive(rpc: JsonRpcProcess, message: RpcMessage): void {
    const params = message.params ?? {};
    const threadId = String(params.threadId ?? "");
    const turn = this.running.get(threadId);
    if (message.id !== undefined && message.method) {
      void this.answer(rpc, message, turn).catch((error: unknown) => {
        turn?.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (!turn) return;
    if (message.method === "turn/started") {
      turn.turnId = String((params.turn as { id: string }).id);
    } else if (message.method === "item/agentMessage/delta") {
      const text = String(params.delta ?? "");
      const id = String(params.itemId ?? "");
      if (text) {
        if (turn.lastTextItem && turn.lastTextItem !== id) turn.input.onText("\n\n");
        turn.lastTextItem = id;
        turn.seenText.add(id);
        turn.input.onText(text);
      }
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item as
        | {
            id: string;
            type: string;
            text?: string;
            command?: string;
            status?: string;
            exitCode?: number | null;
            error?: unknown;
          }
        | undefined;
      if (!item) return;
      const complete = message.method === "item/completed";
      if (item.type === "agentMessage" && complete && !turn.seenText.has(item.id) && item.text) {
        if (turn.lastTextItem && turn.lastTextItem !== item.id) turn.input.onText("\n\n");
        turn.lastTextItem = item.id;
        turn.input.onText(item.text);
        turn.seenText.add(item.id);
      } else if (
        ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)
      ) {
        turn.input.onTool(
          item.id,
          item.type,
          complete,
          complete
            ? item.status === "completed" &&
              (item.exitCode == null || item.exitCode === 0) &&
              !item.error
              ? "succeeded"
              : "failed"
            : undefined,
        );
      }
    } else if (message.method === "turn/completed") {
      const result = params.turn as { status: string; error?: { message: string } | null };
      if (result.status === "failed")
        turn.fail(new Error(result.error?.message || "Codex turn failed."));
      else
        turn.finish(
          result.status === "interrupted" || turn.input.signal.aborted ? "cancelled" : "complete",
        );
    } else if (message.method === "error" && params.willRetry === false) {
      const error = params.error as { message?: string } | undefined;
      turn.fail(new Error(error?.message || "Codex turn failed."));
    }
  }

  private async answer(
    rpc: JsonRpcProcess,
    message: RpcMessage,
    turn?: RunningTurn,
  ): Promise<void> {
    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval"
    ) {
      const params = message.params ?? {};
      const name = message.method.includes("commandExecution") ? "commandExecution" : "fileChange";
      const description =
        [params.reason, params.command, params.cwd, params.grantRoot]
          .filter((value) => typeof value === "string")
          .join("\n") || "Codex requests permission for this operation.";
      const approved =
        turn && !turn.input.signal.aborted && (await turn.input.approve(name, description));
      rpc.send({
        id: message.id,
        result: { decision: approved && !turn?.input.signal.aborted ? "accept" : "decline" },
      });
    } else {
      // Never silently grant unfamiliar server requests (including additional permissions).
      rpc.send({
        id: message.id,
        error: { code: -32601, message: `Kairo does not yet support ${message.method}.` },
      });
      turn?.fail(
        new Error(`Codex requested ${message.method}, which this adapter does not yet support.`),
      );
      if (turn?.turnId)
        void rpc
          .request("turn/interrupt", { threadId: message.params?.threadId, turnId: turn.turnId })
          .catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.rpc?.close();
  }
}
