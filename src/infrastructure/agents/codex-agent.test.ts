import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexAgentAdapter } from "./codex-agent.js";
import type { ExternalRun } from "../../domain/agent-runtime.js";

function adapter() {
  return new CodexAgentAdapter({
    executable: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/codex-server.js", import.meta.url))],
  });
}
function input(prompt: string, overrides: Partial<ExternalRun> = {}): ExternalRun {
  return {
    workspace: "/tmp",
    prompt,
    mode: "build",
    signal: new AbortController().signal,
    onText: () => {},
    onThread: () => {},
    onTool: () => {},
    approve: async () => false,
    ...overrides,
  };
}

test("Codex discovers account/models, streams once, and resumes the saved thread with a different model", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  const info = await agent.inspect();
  assert.equal(info.authenticated, true);
  assert.deepEqual(info.models, [{ id: "fixture-model", label: "Fixture model" }]);
  let threadId = "";
  let text = "";
  const tools: boolean[] = [];
  assert.equal(
    await agent.run(
      input("first", {
        model: "fixture-model",
        onThread: (id) => {
          threadId = id;
        },
        onText: (chunk) => {
          text += chunk;
        },
        onTool: (_id, _name, done) => tools.push(done),
      }),
    ),
    "complete",
  );
  assert.equal(text, `${threadId}:fixture-model:first`);
  assert.deepEqual(tools, [false, true]);
  text = "";
  await agent.run(
    input("plan", {
      threadId,
      mode: "plan",
      onText: (chunk) => {
        text += chunk;
      },
    }),
  );
  assert.equal(text, `${threadId}:default:plan`);
  assert.match((await agent.login()).url, /^https:\/\/auth.openai.com\//);
});

test("Codex concurrent threads keep responses isolated and route approvals to the requesting session", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let first = "";
  let second = "";
  const results = await Promise.all([
    agent.run(
      input("approval", {
        approve: async (_name, description) => {
          assert.match(description, /echo safe/);
          return true;
        },
        onText: (text) => {
          first += text;
        },
      }),
    ),
    agent.run(
      input("other", {
        onText: (text) => {
          second += text;
        },
      }),
    ),
  ]);
  assert.deepEqual(results, ["complete", "complete"]);
  assert.equal(first, "approved");
  assert.match(second, /:other$/);
  assert.doesNotMatch(second, /approved/);
});

test("Codex denies refused approvals and fails closed for unsupported permission requests", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let text = "";
  await agent.run(
    input("approval", {
      onText: (chunk) => {
        text += chunk;
      },
    }),
  );
  assert.equal(text, "denied");
  await assert.rejects(agent.run(input("unsupported")), /does not yet support/);
});

test("Codex interrupts only the selected turn; cancellation before start creates no work", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  const controller = new AbortController();
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  assert.equal(
    await agent.run(
      input("first", {
        signal: alreadyCancelled.signal,
        onThread: () => {
          throw new Error("Started aborted work");
        },
      }),
    ),
    "cancelled",
  );
  const pending = agent.run(
    input("wait", {
      signal: controller.signal,
      onThread: () => setTimeout(() => controller.abort(), 30),
    }),
  );
  const other = agent.run(input("other"));
  assert.deepEqual(await Promise.all([pending, other]), ["cancelled", "complete"]);
});

test("Codex process failure rejects active turns and the next request starts a fresh service", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  await assert.rejects(agent.run(input("crash")), /service stopped/);
  assert.equal(await agent.run(input("recovered")), "complete");
});
