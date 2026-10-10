import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AcpAgentAdapter } from "./acp-agent.js";
import type { ExternalRun } from "../../domain/agent-runtime.js";
const input = (prompt: string, overrides: Partial<ExternalRun> = {}): ExternalRun => ({
  workspace: "/tmp",
  prompt,
  mode: "build",
  signal: new AbortController().signal,
  onThread: () => {},
  onText: () => {},
  onTool: () => {},
  approve: async () => false,
  ...overrides,
});
const adapter = (...args: string[]) =>
  new AcpAgentAdapter("opencode", "Fixture ACP", {
    executable: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/acp-server.js", import.meta.url)), ...args],
  });

test("ACP fresh sessions get handoff context and stream text/tool events", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let text = "";
  const tools: boolean[] = [];
  assert.equal(
    await agent.run(
      input("latest request", {
        context: "saved decisions",
        onText: (chunk) => (text += chunk),
        onTool: (_id, _name, done) => tools.push(done),
      }),
    ),
    "complete",
  );
  assert.equal(text, "build:saved decisions\n\nLatest user request:\nlatest request");
  assert.deepEqual(tools, [false, true]);
});
test("ACP resumed sessions suppress replay and reset Plan to Build", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let text = "";
  await agent.run(
    input("next", {
      threadId: "fixture-session",
      context: "should not replay",
      onText: (chunk) => (text += chunk),
    }),
  );
  assert.equal(text, "build:next");
});
test("ACP missing or unsupported history starts fresh with context", async (t) => {
  for (const flags of [[], ["--no-load"]]) {
    const agent = adapter(...flags);
    t.after(() => agent.close());
    let text = "";
    await agent.run(
      input("next", {
        threadId: "missing",
        context: "saved decisions",
        onText: (chunk) => (text += chunk),
      }),
    );
    assert.match(text, /build:saved decisions\n\nLatest user request:\nnext/);
  }
});
test("ACP permission grants remain scoped to one operation", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let text = "";
  await agent.run(
    input("permission", { approve: async () => true, onText: (chunk) => (text += chunk) }),
  );
  assert.match(text, /"optionId":"once"/);
  assert.doesNotMatch(text, /always/);
});
test("ACP cancellation resolves pending permission even if the approval callback hangs", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  const controller = new AbortController();
  assert.equal(
    await agent.run(
      input("permission", {
        signal: controller.signal,
        approve: () => {
          controller.abort();
          return new Promise(() => {});
        },
      }),
    ),
    "cancelled",
  );
});
test("ACP unsupported client requests fail closed and incomplete turns are errors", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  await assert.rejects(agent.run(input("unsupported")), /unsupported or inactive/);
  await assert.rejects(agent.run(input("limit")), /stopped before completion: max_tokens/);
});

test("ACP forcibly stops a process that ignores cancellation", { timeout: 15000 }, async (t) => {
  const agent = adapter("--ignore-cancel");
  t.after(() => agent.close());
  const controller = new AbortController();
  const started = Date.now();
  const result = await agent.run(
    input("wait", {
      signal: controller.signal,
      onThread: () => setTimeout(() => controller.abort(), 30),
    }),
  );
  assert.equal(result, "cancelled");
  assert.ok(Date.now() - started < 14000, "Cancellation must not wait indefinitely");
});

test("ACP file locations survive tool updates that omit them", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  const paths: (string[] | undefined)[] = [];
  await agent.run(
    input("inspect", { onTool: (_id, _name, _done, _outcome, files) => paths.push(files) }),
  );
  assert.deepEqual(paths, [["/tmp/fixture.ts"], ["/tmp/fixture.ts"]]);
});
