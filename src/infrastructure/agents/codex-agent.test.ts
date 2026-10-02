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

test("Codex mode and model commands do not start an empty thread", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let threadId = "";
  assert.match(
    await agent.executeCommand!({
      workspace: "/tmp",
      command: "plan",
    }),
    /first turn in Plan mode/,
  );
  assert.match(
    await agent.executeCommand!({
      workspace: "/tmp",
      command: "model",
      argument: "fixture-model",
    }),
    /used when the first turn starts/,
  );
  await assert.rejects(
    agent.executeCommand!({ workspace: "/tmp", command: "compact" }),
    /Send a Codex message/,
  );
  assert.equal(threadId, "");
  let text = "";
  assert.equal(
    await agent.run(
      input("first", {
        model: "fixture-model",
        codexMode: "plan",
        onThread: (id) => (threadId = id),
        onText: (chunk) => (text += chunk),
      }),
    ),
    "complete",
  );
  assert.equal(threadId, "thread-1");
  assert.equal(text, `${threadId}:fixture-model:first:plan`);
  assert.equal(
    await agent.executeCommand!({
      threadId,
      workspace: "/tmp",
      command: "model",
      argument: "fixture-model",
    }),
    "Codex model set to fixture-model.",
  );
  assert.match(
    await agent.executeCommand!({ threadId, workspace: "/tmp", command: "default" }),
    /default mode/,
  );
  assert.match(
    await agent.executeCommand!({
      threadId,
      workspace: "/tmp",
      command: "compact",
    }),
    /compaction/,
  );
});

test("Codex replaces only missing-rollout threads and keeps non-rollout errors visible", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let threadId = "missing-rollout";
  let text = "";
  assert.equal(
    await agent.run(
      input("recover", {
        threadId,
        model: "fixture-model",
        codexMode: "plan",
        onThread: (id) => (threadId = id),
        onText: (chunk) => (text += chunk),
      }),
    ),
    "complete",
  );
  assert.equal(threadId, "thread-1");
  assert.match(text, /retrying once in a fresh thread/);
  assert.match(text, /earlier Kairo messages remain visible/i);
  assert.match(text, /thread-1:fixture-model:recover:plan/);

  let persistedId = "";
  await assert.rejects(
    agent.run(
      input("not-recoverable", { threadId: "resume-error", onThread: (id) => (persistedId = id) }),
    ),
    /temporary resume failure/,
  );
  assert.equal(persistedId, "");
});

test("Codex stores a thread id only after turn/start accepts the prompt", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let threadId = "";
  await assert.rejects(
    agent.run(input("start-rejected", { onThread: (id) => (threadId = id) })),
    /turn start rejected/,
  );
  assert.equal(threadId, "");
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

test("Codex native questions return selected and typed answers through the same server request", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  let text = "";
  await agent.run(
    input("questions", {
      onText: (chunk) => {
        text += chunk;
      },
      requestUserInput: async (questions, signal) => {
        assert.equal(signal.aborted, false);
        assert.equal(questions.length, 2);
        assert.equal(questions[0].options?.[0].label, "Minimal");
        assert.equal(questions[1].isSecret, true);
        return { layout: { answers: ["Minimal"] }, note: { answers: ["Extra details"] } };
      },
    }),
  );
  assert.deepEqual(JSON.parse(text), {
    layout: { answers: ["Minimal"] },
    note: { answers: ["Extra details"] },
  });
});

test("Codex clears pending native questions when the server resolves them or the user cancels", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  for (const prompt of ["resolved-question", "questions"]) {
    const controller = new AbortController();
    let questionAborted = false;
    const result = await agent.run(
      input(prompt, {
        signal: controller.signal,
        requestUserInput: (_questions, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                questionAborted = true;
                resolve(undefined);
              },
              { once: true },
            );
            if (prompt === "questions") controller.abort();
          }),
      }),
    );
    assert.equal(result, prompt === "questions" ? "cancelled" : "complete");
    assert.equal(questionAborted, true);
  }
});

test("Codex reads account usage and emits usage/account events without an active turn", async (t) => {
  const agent = adapter();
  t.after(() => agent.close());
  const changes: string[] = [];
  const stop = agent.onUsageChanged((reason) => changes.push(reason));
  const usage = await agent.readUsage();
  assert.equal(usage.defaultBucketId, "codex");
  assert.equal(usage.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(usage.buckets[1].model, "fixture-model");
  await agent.login();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(changes.includes("account"));
  assert.ok(changes.includes("limits"));
  stop();
});
