import { parseCodexUsage, type UsageSnapshot, type UsageChange } from "../../domain/agent-usage.js";
import { parseAgentQuestions, validateAgentAnswers } from "../../domain/agent-user-input.js";
import type {
  ExternalAgentAdapter,
  ExternalAgentInfo,
  ExternalCommand,
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
  questions: Map<string, AbortController>;
  lastTextItem?: string;
  cancelTimer?: ReturnType<typeof setTimeout>;
};

const MISSING_ROLLOUT = /no rollout found for thread id\b/i;

/** Uses the installed CLI's official app-server protocol and existing account configuration. */
export class CodexAgentAdapter implements ExternalAgentAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  private rpc?: JsonRpcProcess;
  private ready?: Promise<JsonRpcProcess>;
  private running = new Map<string, RunningTurn>();
  private closed = false;
  private usageRevision = 0;
  private usageListeners = new Set<(reason: UsageChange) => void>();

  onUsageChanged(listener: (reason: UsageChange) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }
  private usageChanged(reason: UsageChange): void {
    if (reason !== "limits") this.usageRevision++;
    for (const listener of this.usageListeners) listener(reason);
  }
  async readUsage(): Promise<UsageSnapshot> {
    const rpc = await this.connect();
    const revision = this.usageRevision;
    const result = await rpc.request("account/rateLimits/read", {});
    if (revision !== this.usageRevision)
      throw new Error("Codex account changed while reading usage.");
    return parseCodexUsage(result);
  }

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
          this.usageChanged("disconnected");
        }
      });
      try {
        await rpc.request("initialize", {
          clientInfo: { name: "kairo", title: "Kairo", version: "0.1.2" },
          capabilities: { experimentalApi: true },
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

  async executeCommand(input: ExternalCommand): Promise<string> {
    const rpc = await this.connect();
    if (!input.threadId) {
      if (input.command === "compact")
        throw new Error("Send a Codex message before using /compact.");
      if (input.command === "model") {
        const model = input.argument?.trim();
        if (!model) throw new Error("Choose a model with /model <model>.");
        return `Codex model set to ${model}. It will be used when the first turn starts.`;
      }
      return input.command === "plan"
        ? "Codex will start the first turn in Plan mode."
        : "Codex will start the first turn in its default mode.";
    }
    const threadId = input.threadId;
    if (this.running.has(threadId)) throw new Error("Wait for the Codex turn to finish first.");
    switch (input.command) {
      case "plan":
      case "default": {
        const model = input.model ?? (await this.defaultModel(rpc));
        await rpc.request("thread/settings/update", {
          threadId,
          collaborationMode: {
            mode: input.command === "plan" ? "plan" : "default",
            settings: { model, reasoningEffort: null, developerInstructions: null },
          },
        });
        return input.command === "plan"
          ? "Codex switched to Plan mode."
          : "Codex switched to its default mode.";
      }
      case "model": {
        const model = input.argument?.trim();
        if (!model) throw new Error("Choose a model with /model <model>.");
        await rpc.request("thread/settings/update", { threadId, model });
        return `Codex model set to ${model}.`;
      }
      case "compact":
        await rpc.request<ThreadResponse>("thread/resume", {
          threadId,
          cwd: input.workspace,
          model: input.model ?? null,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        });
        await rpc.request("thread/compact/start", { threadId });
        return "Codex started conversation compaction.";
    }
  }

  private async defaultModel(rpc: JsonRpcProcess): Promise<string> {
    const page: { data: { model: string; isDefault?: boolean }[] } = await rpc.request(
      "model/list",
      {
        limit: 100,
        cursor: null,
        includeHidden: false,
      },
    );
    const model = page.data.find((item) => item.isDefault)?.model ?? page.data[0]?.model;
    if (!model) throw new Error("Codex did not provide an available model for its mode setting.");
    return model;
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
      sandbox: "workspace-write",
    };
    let recoveredMissingRollout = false;
    let thread: ThreadResponse;
    if (input.threadId) {
      try {
        thread = await rpc.request<ThreadResponse>("thread/resume", {
          ...settings,
          threadId: input.threadId,
        });
      } catch (error) {
        if (!(error instanceof Error) || !MISSING_ROLLOUT.test(error.message)) throw error;
        thread = await rpc.request<ThreadResponse>("thread/start", settings);
        recoveredMissingRollout = true;
      }
    } else {
      thread = await rpc.request<ThreadResponse>("thread/start", settings);
    }
    const threadId = thread.thread.id;
    if ((recoveredMissingRollout || !input.threadId) && input.codexMode) {
      const model = input.model ?? (await this.defaultModel(rpc));
      await rpc.request("thread/settings/update", {
        threadId,
        collaborationMode: {
          mode: input.codexMode,
          settings: { model, reasoningEffort: null, developerInstructions: null },
        },
      });
    }
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
    const turn: RunningTurn = {
      input,
      finish: resolve,
      fail: reject,
      seenText: new Set(),
      questions: new Map(),
    };
    this.running.set(threadId, turn);
    if (recoveredMissingRollout)
      input.onText(
        "Kairo could not resume the saved Codex history and is retrying once in a fresh thread. " +
          (input.context
            ? "Kairo is supplying a context handoff from the saved conversation.\n\n"
            : "Earlier Kairo messages remain visible but are not part of Codex context.\n\n"),
      );
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
        input: [
          {
            type: "text",
            text:
              (!input.threadId || recoveredMissingRollout) && input.context
                ? `${input.context}\n\nLatest user request:\n${input.prompt}`
                : input.prompt,
            text_elements: [],
          },
        ],
        model: input.model ?? null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [input.workspace],
          networkAccess: false,
        },
      });
      turn.turnId = result.turn.id;
      input.onThread(threadId);
      if (input.signal.aborted) cancel();
      return await completed;
    } catch (error) {
      // A failed request is not proof that the agent stopped editing.
      await rpc.close();
      throw error;
    } finally {
      for (const controller of turn.questions.values()) controller.abort();
      clearTimeout(turn.cancelTimer);
      input.signal.removeEventListener("abort", cancel);
      this.running.delete(threadId);
    }
  }

  private receive(rpc: JsonRpcProcess, message: RpcMessage): void {
    const params = message.params ?? {};
    if (message.id === undefined && message.method === "account/rateLimits/updated") {
      this.usageChanged("limits");
      return;
    }
    if (
      message.id === undefined &&
      (message.method === "account/updated" ||
        (message.method === "account/login/completed" && params.success === true))
    ) {
      this.usageChanged("account");
      return;
    }
    const threadId = String(params.threadId ?? "");
    const turn = this.running.get(threadId);
    if (message.id !== undefined && message.method) {
      void this.answer(rpc, message, turn).catch((error: unknown) => {
        try {
          rpc.send({
            id: message.id,
            error: {
              code: -32602,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } catch {
          // The transport may already be closed during cancellation or shutdown.
        }
        turn?.fail(error instanceof Error ? error : new Error(String(error)));
        if (turn?.turnId)
          void rpc.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => {});
      });
      return;
    }
    if (!turn) return;
    if (message.method === "serverRequest/resolved") {
      turn.questions.get(String(params.requestId))?.abort();
      return;
    }
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
    if (message.method === "item/tool/requestUserInput" && turn?.input.requestUserInput) {
      if (turn.input.signal.aborted || message.params?.turnId !== turn.turnId) {
        rpc.send({
          id: message.id,
          error: { code: -32600, message: "Codex question is no longer active." },
        });
        return;
      }
      const questions = parseAgentQuestions(message.params?.questions);
      const id = String(message.id);
      const controller = new AbortController();
      turn.questions.set(id, controller);
      const signal = AbortSignal.any([turn.input.signal, controller.signal]);
      try {
        const answers = await turn.input.requestUserInput(questions, signal);
        if (
          !signal.aborted &&
          answers &&
          this.running.get(String(message.params?.threadId)) === turn
        )
          rpc.send({
            id: message.id,
            result: { answers: validateAgentAnswers(questions, answers) },
          });
      } finally {
        turn.questions.delete(id);
      }
    } else if (
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
