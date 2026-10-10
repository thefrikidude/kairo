import { createInterface } from "node:readline";
const output = (message: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let promptId: number | undefined;
let mode = "plan";
const modes = {
  availableModes: [
    { id: "plan", name: "Plan" },
    { id: "build", name: "Build" },
  ],
};
const notification = (update: object) =>
  output({ method: "session/update", params: { sessionId: "fixture-session", update } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.jsonrpc !== "2.0") process.exit(2);
  const { id, method, params } = message;
  const reply = (result: object) => output({ id, result });
  if (!method) {
    if (promptId !== undefined) {
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(message.result ?? message.error) },
      });
      output({ id: promptId, result: { stopReason: "end_turn" } });
      promptId = undefined;
    }
  } else if (method === "initialize")
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: !process.argv.includes("--no-load") },
    });
  else if (method === "session/new") reply({ sessionId: "fixture-session", modes });
  else if (method === "session/load") {
    if (params.sessionId === "missing")
      output({ id, error: { code: -32000, message: "Session not found" } });
    else {
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REPLAY_SHOULD_BE_HIDDEN" },
      });
      reply({ modes });
    }
  } else if (method === "session/set_mode") {
    mode = params.modeId;
    reply({});
  } else if (method === "session/cancel") {
    if (promptId !== undefined && !process.argv.includes("--ignore-cancel")) {
      output({ id: promptId, result: { stopReason: "cancelled" } });
      promptId = undefined;
    }
  } else if (method === "session/prompt") {
    promptId = id;
    const text = params.prompt[0].text;
    if (text === "permission" || text === "unsupported") {
      output({
        id: "permission-1",
        method: text === "unsupported" ? "terminal/create" : "session/request_permission",
        params: {
          sessionId: "fixture-session",
          toolCall: { title: "Edit file", rawInput: { path: "example.ts" } },
          options: [
            { kind: "allow_always", optionId: "always" },
            { kind: "allow_once", optionId: "once" },
            { kind: "reject_once", optionId: "deny" },
          ],
        },
      });
    } else if (text !== "wait") {
      notification({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        locations: [{ path: "/tmp/fixture.ts", line: 1 }],
        status: "pending",
      });
      notification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      });
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${mode}:${text}` },
      });
      reply({ stopReason: text === "limit" ? "max_tokens" : "end_turn" });
      promptId = undefined;
    }
  }
});
