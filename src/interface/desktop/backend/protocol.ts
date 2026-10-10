import { createInterface } from "node:readline";
import { createDesktopRuntime, type DesktopRequest } from "./index.js";

const methods = new Set([
  "bootstrap",
  "workspace:open",
  "session:open",
  "session:new",
  "worktrees:list",
  "worktrees:remove",
  "session:rename",
  "session:runtime",
  "agents:refresh",
  "agents:usage",
  "agents:login",
  "session:archive",
  "session:restore",
  "session:delete",
  "sessions:delete-archived",
  "project:archive",
  "project:delete",
  "task:send",
  "codex:command",
  "task:cancel",
  "workspace:list",
  "workspace:directory",
  "workspace:read",
  "workspace:write",
  "workspace:changes",
  "workspace:diff",
  "workspace:cursor-path",
  "model:save",
  "approval:resolve",
  "user-input:resolve",
  "shutdown",
]);

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseRequest(line: string): DesktopRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(request.id) ||
    typeof request.method !== "string" ||
    !methods.has(request.method) ||
    !Array.isArray(request.args)
  )
    return undefined;
  return request as DesktopRequest;
}

const input = createInterface({ input: process.stdin });
const runtime = await createDesktopRuntime((event, payload) => output({ event, payload }));

try {
  await runtime.ready;
  output({ event: "ready", payload: undefined });
} catch (error) {
  output({ event: "ready_error", payload: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

input.on("line", (line) => {
  const request = parseRequest(line);
  if (!request) return;
  void runtime.dispatch(request).then(
    (result) => output({ id: request.id, result }),
    (error: unknown) =>
      output({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
  );
});

input.on("close", () => {
  void runtime.close();
});
