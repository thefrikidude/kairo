import type { ExternalAgentAdapter, ExternalRun } from "../../../domain/agent-runtime.js";
import type { AgentUsage, UsageChange } from "../../../domain/agent-usage.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopRuntime } from "./index.js";
import { SqliteSessionStore } from "../../../infrastructure/persistence/sqlite-session-store.js";
import { AgentRegistry } from "../../../infrastructure/agents/agent-registry.js";
import { CodexAgentAdapter } from "../../../infrastructure/agents/codex-agent.js";
import type { DesktopBootstrap, DesktopApproval } from "../shared/api.js";

async function setup(
  t: TestContext,
  credentialProvider?: string,
  externalAdapter?: ExternalAgentAdapter | ExternalAgentAdapter[],
) {
  const root = await mkdtemp(join(tmpdir(), "kairo-desktop-bridge-"));
  const store = await SqliteSessionStore.open(join(root, "sessions.sqlite"));
  const builtin = store.create(root, {
    kind: "builtin",
    selection: { provider: "mistral", model: "builtin-model" },
  });
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const runtime = await createDesktopRuntime(
    (event, payload) => events.push({ event, payload: payload as Record<string, unknown> }),
    {
      store,
      agents: new AgentRegistry(
        Array.isArray(externalAdapter)
          ? externalAdapter
          : [
              externalAdapter ??
                new CodexAgentAdapter({
                  executable: process.execPath,
                  args: [
                    fileURLToPath(
                      new URL(
                        "../../../infrastructure/agents/fixtures/codex-server.js",
                        import.meta.url,
                      ),
                    ),
                  ],
                }),
            ],
      ),
      credentials: {
        get: async (provider) =>
          provider === credentialProvider ? "private-fixture-key" : undefined,
        save: async () => {},
      },
    },
  );
  await runtime.ready;
  let id = 0;
  const request = <T = unknown>(method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++id, method, args }) as Promise<T>;
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for a desktop event.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, builtin, root, runtime, events, request, wait };
}

test("desktop keeps API-key sessions and routes concurrent external chats independently", async (t) => {
  const { request, store, builtin, events, wait } = await setup(t);
  const first = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
    model: "fixture-model",
  });
  const second = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
  });
  const a = first.activeSessionId!;
  const b = second.activeSessionId!;
  await request("task:send", a, "wait", "build");
  await request("task:send", b, "other", "build");
  await wait(() =>
    events.some((event) => event.payload.sessionId === b && event.payload.state === "complete"),
  );
  await request("task:send", builtin.id, "hi", "build");
  await wait(() =>
    events.some(
      (event) => event.payload.sessionId === builtin.id && event.payload.state === "complete",
    ),
  );
  assert.equal(store.messages(builtin.id).length, 2);
  const opened = await request<DesktopBootstrap>("session:open", a);
  assert.equal(opened.liveSessions[a].state, "running");
  assert.equal(opened.liveSessions[b].state, "complete");
  assert.deepEqual(store.get(builtin.id)?.runtime, {
    kind: "builtin",
    selection: { provider: "mistral", model: "builtin-model" },
  });
  assert.deepEqual(
    store.messages(b).map((message) => message.role),
    ["user", "model"],
  );
  assert.equal(store.messages(a).length, 1);
  await assert.rejects(request("task:send", a, "duplicate", "build"), /already running/);
  await assert.rejects(request("session:delete", a), /Stop the running/);
  await assert.rejects(
    request("session:runtime", a, { kind: "external", agentId: "codex", model: "fixture-model" }),
    /Stop this session/,
  );
  await request("task:cancel", a);
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "cancelled"),
  );
  assert.equal(store.latestTask(a)?.status, "cancelled");
  await request("session:runtime", b, { kind: "builtin" });
  assert.equal(store.get(b)?.runtime.kind, "builtin");
  assert.equal(store.get(b)?.externalSessionId, undefined);
});

test("desktop routes Codex slash commands through its adapter and rejects unsupported commands", async (t) => {
  const { request, store, events, wait } = await setup(t);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
    model: "fixture-model",
  });
  const sessionId = created.activeSessionId!;
  assert.match(await request("codex:command", sessionId, "plan"), /first turn in Plan mode/);
  assert.equal(store.get(sessionId)?.externalSessionId, undefined);
  assert.equal(store.get(sessionId)?.runtime.kind, "external");
  assert.equal((store.get(sessionId)?.runtime as { codexMode?: string }).codexMode, "plan");
  assert.equal(
    await request("codex:command", sessionId, "model", "fixture-model"),
    "Codex model set to fixture-model. It will be used when the first turn starts.",
  );
  assert.equal(store.get(sessionId)?.externalSessionId, undefined);
  assert.equal((store.get(sessionId)?.runtime as { model?: string }).model, "fixture-model");
  await assert.rejects(request("codex:command", sessionId, "compact"), /Send a Codex message/);
  await assert.rejects(
    request("codex:command", sessionId, "not-real"),
    /Unsupported Codex command/,
  );
  await assert.rejects(request("codex:command", "missing-session", "plan"), /Session not found/);
  await request("task:send", sessionId, "first real turn", "build");
  await wait(() =>
    events.some(
      (event) => event.payload.sessionId === sessionId && event.payload.state === "complete",
    ),
  );
  const threadId = store.get(sessionId)?.externalSessionId;
  assert.ok(threadId);
  assert.equal(
    store.messages(sessionId).at(-1)?.content,
    `${threadId}:fixture-model:first real turn:plan`,
  );
});

test("desktop retries an orphaned Codex thread once and persists the replacement", async (t) => {
  const { request, store, events, wait } = await setup(t);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
    model: "fixture-model",
  });
  const sessionId = created.activeSessionId!;
  store.setExternalSessionId(sessionId, "missing-rollout");
  await request("task:send", sessionId, "recover this turn", "build");
  await wait(() =>
    events.some(
      (event) => event.payload.sessionId === sessionId && event.payload.state === "complete",
    ),
  );
  const replacementId = store.get(sessionId)?.externalSessionId;
  assert.equal(replacementId, "thread-1");
  assert.match(
    store.messages(sessionId).at(-1)?.content ?? "",
    /retrying once in a fresh thread[\s\S]*thread-1:fixture-model:recover this turn/,
  );
});

test("background approvals survive chat switching and cancellation resolves only that session", async (t) => {
  const { request, events, builtin, wait } = await setup(t);
  const opened = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
  });
  const a = opened.activeSessionId!;
  await request("task:send", a, "approval", "build");
  await wait(() => events.some((event) => event.event === "approval:request"));
  const background = await request<DesktopBootstrap>("session:open", builtin.id);
  assert.equal(background.liveSessions[a].state, "waiting");
  assert.equal(background.approvals.length, 1);
  const approval: DesktopApproval = background.approvals[0];
  await assert.rejects(request("approval:resolve", approval.id, "unexpected"), /Invalid approval/);
  await request("approval:resolve", approval.id, "approve");
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "complete"),
  );
  const result = await request<DesktopBootstrap>("session:open", a);
  assert.equal(result.messages.at(-1)?.content, "approved");
  assert.equal(result.liveSessions[a].stream, "approved");
  assert.equal(result.approvals.length, 0);
  await request("task:send", a, "approval", "build");
  await wait(() => events.filter((event) => event.event === "approval:request").length === 2);
  await request("task:cancel", a);
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "cancelled"),
  );
  assert.equal((await request<DesktopBootstrap>("bootstrap")).approvals.length, 0);
});

test("desktop validates runtimes/models and preserves external identity on model change", async (t) => {
  const { request, wait, events, store } = await setup(t);
  await assert.rejects(
    request("session:new", { kind: "external", agentId: "unknown" }),
    /No native-chat adapter/,
  );
  await assert.rejects(
    request("session:new", { kind: "external", agentId: "codex", model: "invented" }),
    /available agent model/,
  );
  const opened = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
  });
  const a = opened.activeSessionId!;
  await request("task:send", a, "first", "plan");
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "complete"),
  );
  const threadId = store.get(a)?.externalSessionId;
  assert.ok(threadId);
  await request("session:runtime", a, {
    kind: "external",
    agentId: "codex",
    model: "fixture-model",
  });
  await request("task:send", a, "second", "build");
  await wait(
    () =>
      events.filter((event) => event.payload.sessionId === a && event.payload.state === "complete")
        .length === 2,
  );
  assert.equal(store.get(a)?.externalSessionId, threadId);
  assert.equal(store.messages(a).at(-1)?.content, `${threadId}:fixture-model:second`);
});

test("desktop shutdown cancels a pending external approval before closing its store", async (t) => {
  const { request, events, wait, runtime, root } = await setup(t);
  const opened = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "codex",
  });
  const sessionId = opened.activeSessionId!;
  await request("task:send", sessionId, "approval", "build");
  await wait(() => events.some((event) => event.event === "approval:request"));
  await runtime.close();
  const reopened = await SqliteSessionStore.open(join(root, "sessions.sqlite"));
  assert.equal(reopened.latestTask(sessionId)?.status, "cancelled");
  reopened.close();
});

test("bootstrap reports credentials per provider without exposing keys", async (t) => {
  const { request } = await setup(t, "groq");
  const state = await request<DesktopBootstrap>("bootstrap");
  assert.equal(state.hasCredential, false);
  assert.equal(state.providers.find((provider) => provider.id === "groq")?.hasCredential, true);
  assert.equal(state.providers.find((provider) => provider.id === "mistral")?.hasCredential, false);
  assert.equal(JSON.stringify(state).includes("private-fixture-key"), false);
});

test("archive deletion removes only the chosen history and bulk deletion keeps active chats", async (t) => {
  const { request, store, builtin, root } = await setup(t);
  const archived = [store.create(root), store.create(root)];
  const tasks = archived.map((session) => {
    store.addMessage(session.id, { role: "user", content: "Archived history", createdAt: 1 });
    const task = store.startTask(session.id, "Archived task");
    store.archive(session.id);
    return task;
  });
  store.addMessage(builtin.id, { role: "user", content: "Active history", createdAt: 2 });
  const individual = await request<DesktopBootstrap>("session:delete", archived[0].id);
  assert.equal(individual.archivedSessions.length, 1);
  assert.equal(store.get(archived[0].id), undefined);
  assert.equal(store.task(tasks[0].id), undefined);
  assert.deepEqual(store.messages(archived[0].id), []);
  const all = await request<DesktopBootstrap>("sessions:delete-archived");
  assert.deepEqual(all.archivedSessions, []);
  assert.equal(store.get(archived[1].id), undefined);
  assert.equal(store.task(tasks[1].id), undefined);
  assert.deepEqual(store.messages(archived[1].id), []);
  assert.equal(all.activeSessionId, builtin.id);
  assert.equal(all.sessions.length, 1);
  assert.equal(store.messages(builtin.id)[0]?.content, "Active history");
  assert.deepEqual(
    (await request<DesktopBootstrap>("sessions:delete-archived")).archivedSessions,
    [],
  );
});

test("native Codex questions survive switching, validate answers, and stay scoped to their session", async (t) => {
  const { request, events, builtin, wait, store } = await setup(t);
  const a = (await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" }))
    .activeSessionId!;
  const b = (await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" }))
    .activeSessionId!;
  await request("task:send", a, "questions", "build");
  await request("task:send", b, "questions", "build");
  await wait(() => events.filter((event) => event.event === "user-input:request").length === 2);
  const background = await request<DesktopBootstrap>("session:open", builtin.id);
  assert.equal(background.liveSessions[a].state, "waiting");
  assert.equal(background.liveSessions[b].state, "waiting");
  assert.equal(background.userInputs.length, 2);
  const qa = background.userInputs.find((question) => question.sessionId === a)!;
  await assert.rejects(request("user-input:resolve", qa.id, {}), /Answer each/);
  assert.equal((await request<DesktopBootstrap>("bootstrap")).userInputs.length, 2);
  await request("user-input:resolve", qa.id, {
    layout: { answers: ["Custom design"] },
    note: { answers: ["private answer"] },
  });
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "complete"),
  );
  const remaining = await request<DesktopBootstrap>("bootstrap");
  assert.equal(remaining.userInputs.length, 1);
  assert.equal(remaining.userInputs[0].sessionId, b);
  assert.equal(remaining.liveSessions[b].state, "waiting");
  // Kairo forwards answers without appending a separate transcript message (including secrets).
  assert.deepEqual(
    store.messages(a).map((message) => message.role),
    ["user", "model"],
  );
  await assert.rejects(request("user-input:resolve", qa.id, {}), /no longer active/);
  await request("task:cancel", b);
  await wait(() =>
    events.some((event) => event.payload.sessionId === b && event.payload.state === "cancelled"),
  );
  assert.equal((await request<DesktopBootstrap>("bootstrap")).userInputs.length, 0);
  assert.ok(
    events.some((event) => event.event === "user-input:resolved" && event.payload.sessionId === b),
  );
});

test("Codex server resolution and shutdown release unanswered questions", async (t) => {
  const { request, events, wait, runtime } = await setup(t);
  const id = (
    await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" })
  ).activeSessionId!;
  await request("task:send", id, "resolved-question", "build");
  await wait(() =>
    events.some((event) => event.payload.sessionId === id && event.payload.state === "complete"),
  );
  assert.equal((await request<DesktopBootstrap>("bootstrap")).userInputs.length, 0);
  await request("task:send", id, "questions", "build");
  await wait(() => events.filter((event) => event.event === "user-input:request").length === 2);
  await runtime.close();
});

test("agent usage is cached, deduplicated and failures stay out of chat state", async (t) => {
  let reads = 0;
  let fail = false;
  let notify: (reason: UsageChange) => void = () => {};
  const adapter: ExternalAgentAdapter = {
    id: "codex",
    name: "Codex",
    inspect: async () => ({
      id: "codex",
      name: "Codex",
      installed: true,
      authenticated: true,
      models: [],
    }),
    login: async () => ({ url: "https://auth.openai.com" }),
    run: async () => "complete",
    close: async () => {},
    onUsageChanged: (listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    readUsage: async () => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (fail) throw new Error("usage offline");
      return {
        defaultBucketId: "codex",
        buckets: [{ id: "codex", label: "Codex", windows: [{ remainingPercent: 75 }] }],
      };
    },
  };
  const { request, events, wait, builtin } = await setup(t, undefined, adapter);
  const a = (await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" }))
    .activeSessionId!;
  const b = (await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" }))
    .activeSessionId!;
  const [first, second] = await Promise.all([
    request<AgentUsage>("agents:usage", a),
    request<AgentUsage>("agents:usage", b),
  ]);
  assert.equal(first.status, "available");
  assert.deepEqual(first, second);
  assert.equal(reads, 1);
  await request("agents:usage", a);
  assert.equal(reads, 1);
  fail = true;
  const stale = await request<AgentUsage>("agents:usage", a, true);
  assert.equal(stale.status, "stale");
  assert.equal(stale.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(stale.error, "usage offline");
  assert.equal(
    events.some((event) => event.event === "task:state" && event.payload.state === "error"),
    false,
  );
  assert.equal((await request<AgentUsage>("agents:usage", builtin.id)).status, "unavailable");
  fail = false;
  notify("account");
  const cleared = events.at(-1)!.payload;
  assert.deepEqual(cleared.buckets, []);
  assert.equal(cleared.status, "loading");
  await wait(() => reads === 3 && events.at(-1)?.payload.status === "available");
  notify("disconnected");
  assert.equal(events.at(-1)?.payload.status, "unavailable");
  assert.deepEqual(events.at(-1)?.payload.buckets, []);
});

test("an account change discards an old in-flight usage snapshot and refreshes native updates", async (t) => {
  let notify: (reason: UsageChange) => void = () => {};
  let release!: () => void;
  let reads = 0;
  const adapter: ExternalAgentAdapter = {
    id: "codex",
    name: "Codex",
    inspect: async () => ({
      id: "codex",
      name: "Codex",
      installed: true,
      authenticated: true,
      models: [],
    }),
    login: async () => ({ url: "https://auth.openai.com" }),
    run: async () => "complete",
    close: async () => {},
    onUsageChanged: (listener) => {
      notify = listener;
      return () => {};
    },
    readUsage: async () => {
      const count = ++reads;
      if (count === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        defaultBucketId: "codex",
        buckets: [
          {
            id: "codex",
            label: count === 1 ? "Old account" : "New account",
            windows: [{ remainingPercent: count === 1 ? 20 : 80 }],
          },
        ],
      };
    },
  };
  const { request, events, wait } = await setup(t, undefined, adapter);
  const id = (
    await request<DesktopBootstrap>("session:new", { kind: "external", agentId: "codex" })
  ).activeSessionId!;
  const oldRead = request<AgentUsage>("agents:usage", id);
  await wait(() => reads === 1);
  notify("account");
  release();
  assert.deepEqual((await oldRead).buckets, []);
  await wait(() => reads === 2 && events.at(-1)?.payload.status === "available");
  assert.equal((await request<AgentUsage>("agents:usage", id)).buckets[0].label, "New account");
  notify("limits");
  await wait(() => reads === 3);
  assert.equal(
    events.some((event) => JSON.stringify(event.payload).includes("Old account")),
    false,
  );
});

function switchingAdapter(
  id: string,
  run: ExternalAgentAdapter["run"],
  authenticated = true,
): ExternalAgentAdapter {
  return {
    id,
    name: id,
    inspect: async () => ({ id, name: id, installed: true, authenticated, models: [] }),
    login: async () => ({ url: "https://example.com" }),
    run,
    close: async () => {},
  };
}

test("switching an active task waits for cancellation and hands partial output to the new agent", async (t) => {
  let stopped = false;
  let destination: ExternalRun | undefined;
  const first = switchingAdapter("first", async (input) => {
    input.onThread("old-native-thread");
    input.onText("Implemented the first part.");
    await new Promise<void>((resolve) =>
      input.signal.addEventListener(
        "abort",
        () =>
          setTimeout(() => {
            stopped = true;
            resolve();
          }, 30),
        { once: true },
      ),
    );
    return "cancelled";
  });
  const second = switchingAdapter("second", async (input) => {
    assert.equal(stopped, true);
    destination = input;
    input.onThread("new-native-thread");
    input.onText("Continued the remaining work.");
    return "complete";
  });
  const { request, store, wait, events } = await setup(t, undefined, [first, second]);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "first",
  });
  const id = created.activeSessionId!;
  await request("task:send", id, "Implement feature; preserve public API", "plan");
  await wait(() => store.get(id)?.externalSessionId === "old-native-thread");
  await request("session:runtime", id, { kind: "external", agentId: "second" });
  await wait(() =>
    events.some((event) => event.payload.sessionId === id && event.payload.state === "complete"),
  );
  assert.equal(destination?.threadId, undefined);
  assert.equal(destination?.mode, "plan");
  assert.match(destination?.context ?? "", /preserve public API/);
  assert.match(destination?.context ?? "", /Implemented the first part/);
  assert.equal(store.get(id)?.externalSessionId, "new-native-thread");
  assert.equal(
    store.messages(id).find((message) => message.content === "Implemented the first part.")
      ?.agentName,
    "first",
  );
  assert.equal(store.messages(id).at(-1)?.agentName, "second");
  assert.equal(
    store.messages(id).filter((message) => message.toolName === "agent_handoff").length,
    1,
  );
});

test("an unauthenticated destination does not interrupt the current agent", async (t) => {
  let source: ExternalRun | undefined;
  const first = switchingAdapter("first", async (input) => {
    source = input;
    input.onThread("current");
    await new Promise<void>((resolve) =>
      input.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "cancelled";
  });
  const second = switchingAdapter(
    "second",
    async () => {
      throw new Error("Must not start");
    },
    false,
  );
  const { request, wait, store } = await setup(t, undefined, [first, second]);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "first",
  });
  const id = created.activeSessionId!;
  await request("task:send", id, "Do the task", "build");
  await wait(() => Boolean(source));
  await assert.rejects(
    request("session:runtime", id, { kind: "external", agentId: "second" }),
    /Sign in/,
  );
  assert.equal(source?.signal.aborted, false);
  assert.equal((store.get(id)?.runtime as { agentId: string }).agentId, "first");
});

test("idle switching and switching back reset native history but preserve Kairo context", async (t) => {
  const inputs: ExternalRun[] = [];
  const run = async (input: ExternalRun): Promise<"complete"> => {
    inputs.push(input);
    input.onThread(`${inputs.length}-native`);
    input.onText("Done");
    return "complete";
  };
  const { request, store, wait, events } = await setup(t, undefined, [
    switchingAdapter("first", run),
    switchingAdapter("second", run),
  ]);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "first",
  });
  const id = created.activeSessionId!;
  await request("task:send", id, "Keep compatibility", "build");
  await wait(() =>
    events.some((event) => event.payload.sessionId === id && event.payload.state === "complete"),
  );
  await request("session:runtime", id, { kind: "external", agentId: "second" });
  assert.equal(inputs.length, 1);
  assert.equal(store.get(id)?.externalSessionId, undefined);
  await request("session:runtime", id, { kind: "external", agentId: "first" });
  await request("task:send", id, "Continue", "build");
  await wait(() => store.messages(id).at(-1)?.content === "Done");
  assert.equal(inputs[1]?.threadId, undefined);
  assert.match(inputs[1]?.context ?? "", /Keep compatibility/);
  const reopened = await SqliteSessionStore.open(
    join(created.sessions.find((session) => session.id === id)!.workspace, "sessions.sqlite"),
  );
  try {
    assert.equal(reopened.get(id)?.externalSessionId, "2-native");
    assert.match(reopened.latestCheckpoint(id)?.summary ?? "", /Keep compatibility/);
  } finally {
    reopened.close();
  }
});

test("switching blocks new sends and another switch while cancellation is pending", async (t) => {
  let release!: () => void;
  let source: ExternalRun | undefined;
  const first = switchingAdapter("first", async (input) => {
    source = input;
    input.onThread("old");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "cancelled";
  });
  const second = switchingAdapter("second", async () => "complete");
  const { request, wait } = await setup(t, undefined, [first, second]);
  const created = await request<DesktopBootstrap>("session:new", {
    kind: "external",
    agentId: "first",
  });
  const id = created.activeSessionId!;
  await request("task:send", id, "Work", "build");
  await wait(() => Boolean(source));
  const switching = request("session:runtime", id, { kind: "external", agentId: "second" });
  await wait(() => source!.signal.aborted);
  await assert.rejects(request("task:send", id, "Another task", "build"), /switch to finish/);
  await assert.rejects(
    request("session:runtime", id, { kind: "external", agentId: "first" }),
    /already in progress/,
  );
  release();
  await switching;
});
