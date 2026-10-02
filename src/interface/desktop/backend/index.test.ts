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

async function setup(t: TestContext, credentialProvider?: string) {
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
      agents: new AgentRegistry([
        new CodexAgentAdapter({
          executable: process.execPath,
          args: [
            fileURLToPath(
              new URL("../../../infrastructure/agents/fixtures/codex-server.js", import.meta.url),
            ),
          ],
        }),
      ]),
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
  await assert.rejects(request("session:runtime", a, { kind: "builtin" }), /Stop this session/);
  await request("task:cancel", a);
  await wait(() =>
    events.some((event) => event.payload.sessionId === a && event.payload.state === "cancelled"),
  );
  assert.equal(store.latestTask(a)?.status, "cancelled");
  await assert.rejects(request("session:runtime", b, { kind: "builtin" }), /new chat/);
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
