// Opt-in smoke: uses installed/authenticated CLIs and their configured accounts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDesktopRuntime } from "../dist/interface/desktop/backend/index.js";
import { SqliteSessionStore } from "../dist/infrastructure/persistence/sqlite-session-store.js";
import { GitWorkspaces } from "../dist/infrastructure/repository/git-workspaces.js";
import { AgentRegistry } from "../dist/infrastructure/agents/agent-registry.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-native-workflow-")));
const output = resolve(
  process.env.KAIRO_NATIVE_OUTPUT || join(tmpdir(), `kairo-native-evidence-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const project = join(root, "project");
await mkdir(project);
await writeFile(join(project, "README.md"), "# Native agent smoke fixture\n");
const git = (args, cwd = project) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(["init", "-b", "main"]);
git(["config", "user.name", "Kairo smoke"]);
git(["config", "user.email", "fixture@example.test"]);
git(["add", "."]);
git(["commit", "-m", "Initial fixture"]);
const db = join(root, "sessions.sqlite");
const store = await SqliteSessionStore.open(db);
const registry = new AgentRegistry();
let runtime;
let requestId = 0;
const states = new Map();
const approvalJobs = [];
const request = (method, ...args) => runtime.dispatch({ id: ++requestId, method, args });
try {
  runtime = await createDesktopRuntime(
    (event, payload) => {
      if (event === "task:state") {
        states.set(payload.sessionId, payload);
        console.log(`Native task ${payload.sessionId.slice(0, 8)}: ${payload.state}`);
      }
      if (event === "approval:request") {
        // These are manually requested local fixture tasks, never background agent delegation.
        approvalJobs.push(request("approval:resolve", payload.id, "approve"));
      }
    },
    {
      store,
      agents: registry,
      worktrees: new GitWorkspaces(join(root, "worktrees")),
      credentials: { get: async () => undefined, save: async () => {} },
    },
  );
  await runtime.ready;
  const agents = await request("agents:refresh");
  for (const id of ["codex", "opencode"]) {
    const agent = agents.find((item) => item.id === id);
    assert.ok(
      agent?.installed && agent?.authenticated && !agent.error,
      `${id} must be installed and authenticated: ${agent?.error ?? "unavailable"}`,
    );
  }
  const sessions = [];
  for (const agentId of ["codex", "opencode"]) {
    const next = await request(
      "session:new",
      {
        kind: "external",
        agentId,
        ...(agentId === "codex"
          ? { model: process.env.KAIRO_NATIVE_CODEX_MODEL || "gpt-6-sol" }
          : {}),
      },
      project,
      {
        kind: "worktree",
        branch: `kairo/${agentId}-smoke`,
      },
    );
    sessions.push(next.sessions.find((item) => item.id === next.activeSessionId));
  }
  assert.notEqual(sessions[0].workspaceId, sessions[1].workspaceId);
  for (const session of sessions) {
    const id = session.runtime.agentId;
    const prompt = `This is a tiny local Kairo integration smoke task in the current working directory. Create ${id}-proof.txt containing exactly ${id.toUpperCase()}_OK followed by a newline, using your normal file editing tool. Then run a Node.js command that reads this file and exits nonzero if its contents differ from that exact text. Do not commit, install packages, access the network, delegate to other agents, or modify any other file. Finish with one sentence reporting the verification result.`;
    await request("task:send", session.id, prompt, "build");
  }
  const concurrent = await request("session:open", sessions[0].id);
  assert.equal(concurrent.liveSessions[sessions[0].id].state, "running");
  assert.equal(concurrent.liveSessions[sessions[1].id].state, "running");
  const deadline = Date.now() + 180_000;
  while (
    sessions.some(
      (session) => !["complete", "error", "cancelled"].includes(states.get(session.id)?.state),
    )
  ) {
    if (Date.now() > deadline) throw new Error("Native smoke exceeded three minutes.");
    await new Promise((done) => setTimeout(done, 100));
  }
  await Promise.all(approvalJobs);
  const results = [];
  for (const session of sessions) {
    const id = session.runtime.agentId;
    const state = states.get(session.id);
    assert.equal(state.state, "complete", `${id}: ${state.error ?? state.state}`);
    assert.equal(
      await readFile(join(session.workspace, `${id}-proof.txt`), "utf8"),
      `${id.toUpperCase()}_OK\n`,
    );
    await assert.rejects(readFile(join(project, `${id}-proof.txt`)));
    const other = sessions.find((item) => item.id !== session.id);
    await assert.rejects(readFile(join(other.workspace, `${id}-proof.txt`)));
    const review = await request("workspace:review", session.id, "task");
    assert.deepEqual(
      review.changes.map((item) => item.path),
      [`${id}-proof.txt`],
    );
    const patch = await request("workspace:diff", session.id, `${id}-proof.txt`, "task");
    assert.ok(patch.diff.includes(`${id.toUpperCase()}_OK`));
    const stored = store.get(session.id);
    assert.ok(stored.externalSessionId);
    assert.ok(store.messages(session.id).some((message) => message.role === "model"));
    results.push({
      agentId: id,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      nativeHistoryId: stored.externalSessionId,
      changedFiles: review.changes.map((item) => item.path),
      activityEvents: store.taskEvents(store.latestTask(session.id).id).length,
      status: store.latestTask(session.id).status,
    });
  }
  await runtime.close();
  runtime = undefined;
  const reopened = await SqliteSessionStore.open(db);
  try {
    for (const result of results) {
      assert.equal(reopened.get(result.sessionId).workspaceId, result.workspaceId);
      assert.equal(reopened.get(result.sessionId).externalSessionId, result.nativeHistoryId);
      assert.ok(reopened.messages(result.sessionId).length >= 2);
    }
  } finally {
    reopened.close();
  }
  await writeFile(
    join(output, "native-workflow.json"),
    JSON.stringify(
      {
        results,
        concurrentSessions: true,
        isolation: true,
        reviewedPatches: true,
        sqliteRestart: true,
        approvalCount: approvalJobs.length,
      },
      null,
      2,
    ),
  );
  console.log(`Native workflow passed. Evidence: ${output}`);
} finally {
  if (runtime) await runtime.close();
  await registry.close();
  await rm(root, { recursive: true, force: true });
}
