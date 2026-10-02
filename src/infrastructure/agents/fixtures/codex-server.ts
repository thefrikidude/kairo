/** Scripted protocol peer for exercising real subprocess transport and routing. No model calls. */
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const turns = new Map<string, { prompt: string; id: string }>();
const approvals = new Map<string, string>();
const modes = new Map<string, string>();
let nextThread = 0;
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method: string, params: unknown) => output({ method, params });
function finish(threadId: string, text: string, status = "completed") {
  const turn = turns.get(threadId);
  if (!turn) return;
  notify("item/agentMessage/delta", { threadId, itemId: `text-${turn.id}`, delta: text });
  notify("item/completed", {
    threadId,
    item: { id: `text-${turn.id}`, type: "agentMessage", text },
  });
  notify("turn/completed", { threadId, turn: { id: turn.id, status } });
  turns.delete(threadId);
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const threadId = approvals.get(String(message.id));
    if (threadId) {
      approvals.delete(String(message.id));
      finish(
        threadId,
        message.result?.decision === "accept"
          ? "approved"
          : message.error
            ? "unsupported"
            : "denied",
      );
    }
    return;
  }
  const { id, method, params } = message;
  const reply = (result: unknown) => output({ id, result });
  if (method === "initialize") {
    if (params.capabilities?.experimentalApi !== true)
      throw new Error("Experimental API is required");
    reply({ userAgent: "fixture" });
  } else if (method === "initialized") return;
  else if (method === "account/read")
    reply({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  else if (method === "model/list")
    reply({ data: [{ model: "fixture-model", displayName: "Fixture model" }], nextCursor: null });
  else if (method === "account/login/start")
    reply({ authUrl: "https://auth.openai.com/authorize?fixture=true" });
  else if (method === "thread/settings/update") {
    const mode = params.collaborationMode?.mode;
    if (typeof mode === "string") modes.set(params.threadId, mode);
    reply({});
  } else if (method === "thread/compact/start") reply({});
  else if (method === "thread/resume" && params.threadId === "missing-rollout") {
    output({
      id,
      error: { code: -32000, message: `no rollout found for thread id ${params.threadId}` },
    });
  } else if (method === "thread/resume" && params.threadId === "resume-error") {
    output({ id, error: { code: -32000, message: "temporary resume failure" } });
  } else if (method === "thread/start" || method === "thread/resume") {
    if (params.sandbox !== "read-only" && params.sandbox !== "workspace-write")
      throw new Error("Missing sandbox");
    reply({
      thread: { id: method === "thread/resume" ? params.threadId : `thread-${++nextThread}` },
    });
  } else if (method === "turn/start") {
    const prompt = params.input[0].text;
    if (params.approvalPolicy !== "on-request" || params.approvalsReviewer !== "user")
      throw new Error("Unsafe approvals");
    if (!Array.isArray(params.input[0].text_elements)) throw new Error("Missing text elements");
    if (
      params.sandboxPolicy.type !== "workspaceWrite" ||
      !Array.isArray(params.sandboxPolicy.writableRoots)
    )
      throw new Error("Codex must use its own collaboration mode without Kairo Plan sandboxing");
    if (prompt === "crash") {
      process.exit(2);
    }
    if (prompt === "start-rejected") {
      output({ id, error: { code: -32000, message: "turn start rejected" } });
      return;
    }
    const turn = { prompt, id: `turn-${params.threadId}-${Date.now()}` };
    turns.set(params.threadId, turn);
    reply({ turn: { id: turn.id } });
    notify("turn/started", { threadId: params.threadId, turn: { id: turn.id } });
    if (prompt === "approval" || prompt === "unsupported") {
      const requestId = `approve-${params.threadId}`;
      approvals.set(requestId, params.threadId);
      output({
        id: requestId,
        method:
          prompt === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/permissions/requestApproval",
        params: {
          threadId: params.threadId,
          turnId: turn.id,
          command: "echo safe",
          reason: "fixture approval",
        },
      });
    } else if (prompt !== "wait") {
      notify("item/started", {
        threadId: params.threadId,
        item: { id: `command-${turn.id}`, type: "commandExecution" },
      });
      notify("item/completed", {
        threadId: params.threadId,
        item: { id: `command-${turn.id}`, type: "commandExecution", status: "completed" },
      });
      setTimeout(
        () =>
          finish(
            params.threadId,
            `${params.threadId}:${params.model ?? "default"}:${prompt}${modes.has(params.threadId) ? `:${modes.get(params.threadId)}` : ""}`,
          ),
        20,
      );
    }
  } else if (method === "turn/interrupt") {
    reply({});
    finish(params.threadId, "", "interrupted");
  } else output({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
});
