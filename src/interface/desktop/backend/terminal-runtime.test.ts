import {
  NativeSessionReader,
  type NativeSessionRecord,
} from "../../../infrastructure/agents/native-session-reader.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalDesktopRuntime } from "./terminal-runtime.js";
import { SqliteTerminalSessionStore } from "../../../infrastructure/persistence/sqlite-terminal-session-store.js";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import { terminalAgentCatalog } from "../../../infrastructure/agents/terminal-agent-catalog.js";
import { terminalProcesses } from "../../../infrastructure/terminal/terminal-processes.js";
import type { TerminalLaunch, NativeAgentSession } from "../../../domain/terminal-agent.js";
import type {
  TerminalDesktopBootstrap,
  TerminalSnapshot,
  WorkspaceReview,
} from "../shared/terminal-api.js";

const run = promisify(execFile);
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Timed out waiting for agent fixture.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("terminal desktop owns independent workspaces, live navigation, Git review and exact persisted resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-terminal-runtime-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await run("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Fixture repository\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Initial",
  ]);
  const database = join(root, "sessions.sqlite");
  const launches: { id: string; native?: NativeAgentSession }[] = [];
  const fixture = `console.log('AGENT_READY');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{try{const v=JSON.parse(line);require('node:fs').writeFileSync(v.file,v.content);console.log('FILE_SAVED')}catch{}});setInterval(()=>{},1000)`;
  const agents = {
    async refresh() {
      return terminalAgentCatalog.map((agent) => ({
        ...agent,
        installed: agent.id === "codex",
        resumable: agent.id === "codex",
      }));
    },
    async launch(
      _agentId: string,
      id: string,
      native?: NativeAgentSession,
    ): Promise<TerminalLaunch> {
      launches.push({ id, native });
      return {
        executable: process.execPath,
        args: ["-e", fixture],
        title: "Fixture agent",
        sessionId: id,
      };
    },
  };
  let runtime = await createTerminalDesktopRuntime(() => {}, {
    store: await SqliteTerminalSessionStore.open(database),
    agents,
    worktrees: new GitWorkspaces(join(root, "worktrees")),
  });
  let requestId = 0;
  const request = (method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++requestId, method, args });
  let owned: number[] = [];
  try {
    await runtime.ready;
    let state = (await request("workspace:open", repo)) as TerminalDesktopBootstrap;
    assert.equal(state.sessions.length, 0); // Opening a repository does not invent a chat.
    assert.ok(state.activeWorkspaceId);
    state = (await request("session:new", "codex", repo, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const primary = state.sessions[0];
    const primaryPty = state.terminals.find((terminal) => terminal.sessionId === primary.id)!;
    owned.push(primaryPty.pid);
    await until(async () =>
      ((await request("terminal:attach", primaryPty.id)) as TerminalSnapshot).buffer.includes(
        "AGENT_READY\r\n",
      ),
    );
    state = (await request("session:new", "codex", repo, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const shared = state.sessions.find((session) => session.id === state.activeSessionId)!;
    const sharedPty = state.terminals.find((terminal) => terminal.sessionId === shared.id)!;
    owned.push(sharedPty.pid);
    assert.equal(shared.workspaceId, primary.workspaceId);
    assert.notEqual(sharedPty.pid, primaryPty.pid);
    await request("session:archive", shared.id);
    state = (await request("session:new", "codex", repo, {
      kind: "worktree",
      branch: "task-a",
    })) as TerminalDesktopBootstrap;
    const isolated = state.sessions.find((session) => session.id === state.activeSessionId)!;
    const isolatedPty = state.terminals.find((terminal) => terminal.sessionId === isolated.id)!;
    owned.push(isolatedPty.pid);
    const directory = state.workspaces.find(
      (workspace) => workspace.id === isolated.workspaceId,
    )!.directory;
    assert.notEqual(primary.workspaceId, isolated.workspaceId);
    await request(
      "terminal:write",
      isolatedPty.id,
      JSON.stringify({ file: "proof.txt", content: "isolated\n" }) + "\r",
    );
    await until(async () =>
      ((await request("terminal:attach", isolatedPty.id)) as TerminalSnapshot).buffer.includes(
        "FILE_SAVED\r\n",
      ),
    );
    assert.equal(await readFile(join(directory, "proof.txt"), "utf8"), "isolated\n");
    await assert.rejects(readFile(join(repo, "proof.txt")), /ENOENT/);
    state = (await request("session:open", primary.id)) as TerminalDesktopBootstrap;
    assert.equal(state.terminals.filter((terminal) => terminal.state === "running").length, 2);
    assert.equal(
      state.terminals.find((terminal) => terminal.sessionId === isolated.id)!.id,
      isolatedPty.id,
    );
    const review = (await request("workspace:review", isolated.id, "task")) as WorkspaceReview;
    assert.deepEqual(
      review.changes.map((change) => change.path),
      ["proof.txt"],
    );
    assert.match(
      ((await request("workspace:diff", isolated.id, "proof.txt", "task")) as { diff: string })
        .diff,
      /isolated/,
    );
    state = (await request("session:archive", isolated.id)) as TerminalDesktopBootstrap;
    assert.ok(state.archivedSessions.some((session) => session.id === isolated.id));
    assert.ok(!state.terminals.some((terminal) => terminal.sessionId === isolated.id));
    assert.ok(state.terminals.some((terminal) => terminal.sessionId === primary.id));
    await assert.rejects(request("worktrees:remove", isolated.workspaceId), /contains staged/);
    await rm(join(directory, "proof.txt"));
    state = (await request("worktrees:remove", isolated.workspaceId)) as TerminalDesktopBootstrap;
    assert.ok(
      state.workspaces.find((workspace) => workspace.id === isolated.workspaceId)!.removedAt,
    );
    await assert.rejects(request("session:restore", isolated.id), /unavailable/);
    await request("session:stop", primary.id);
    await request("session:native", primary.id, { id: "native-exact-session" });
    await request("session:rename", primary.id, "Persistent terminal");
    await runtime.close();
    assert.ok(
      !(await terminalProcesses()).some(
        (process) => owned.includes(process.pid) && !process.zombie,
      ),
    );
    runtime = await createTerminalDesktopRuntime(() => {}, {
      store: await SqliteTerminalSessionStore.open(database),
      agents,
      worktrees: new GitWorkspaces(join(root, "worktrees")),
    });
    await runtime.ready;
    state = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.equal(state.activeSessionId, primary.id);
    assert.equal(
      state.sessions.find((session) => session.id === primary.id)!.title,
      "Persistent terminal",
    );
    assert.equal(launches.at(-1)!.native!.id, "native-exact-session");
    owned.push(state.terminals[0].pid);
    await runtime.close();
    await assert.rejects(request("bootstrap"), /shutting down/);
    assert.ok(
      !(await terminalProcesses()).some(
        (process) => owned.includes(process.pid) && !process.zombie,
      ),
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing resume identity invokes a native picker or requires an explicit fresh start", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-resume-policy-"));
  const launches: { agent: string; native?: NativeAgentSession; picker: boolean }[] = [];
  class EmptyReader extends NativeSessionReader {
    override supports() {
      return false;
    }
  }
  const agents = {
    async refresh() {
      return terminalAgentCatalog.map((agent) => ({
        ...agent,
        installed: true,
        resumable: ["codex", "opencode"].includes(agent.id),
      }));
    },
    async launch(
      agent: string,
      id: string,
      native?: NativeAgentSession,
      picker = false,
    ): Promise<TerminalLaunch> {
      launches.push({ agent, native, picker });
      return {
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        title: agent,
        sessionId: id,
      };
    },
  };
  const runtime = await createTerminalDesktopRuntime(() => {}, {
    store: await SqliteTerminalSessionStore.open(join(root, "state.sqlite")),
    agents,
    nativeReader: new EmptyReader(root),
  });
  let seq = 0;
  const request = (method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++seq, method, args });
  try {
    await runtime.ready;
    let state = (await request("session:new", "opencode", root, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const open = state.activeSessionId!;
    assert.ok(state.sessions[0].lastStartedAt);
    await request("session:stop", open);
    const count = launches.length;
    await assert.rejects(request("session:start", open), /native session ID is missing/);
    assert.equal(launches.length, count);
    await request("session:start", open, "fresh");
    assert.equal(launches.length, count + 1);
    await request("session:stop", open);
    state = (await request("session:new", "codex", root, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const codex = state.activeSessionId!;
    await request("session:stop", codex);
    await request("session:start", codex);
    assert.equal(launches.at(-1)!.picker, true);
    assert.equal(launches.at(-1)!.native, undefined);
    await request("session:stop", codex);
    state = (await request("session:new", "aider", root, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const aider = state.activeSessionId!;
    await request("session:stop", aider);
    state = (await request("session:start", aider)) as TerminalDesktopBootstrap;
    assert.match(state.sessionNotices[aider], /fresh conversation each time/);
    assert.equal(launches.at(-1)!.picker, false);
    const child = join(root, "child");
    await mkdir(child);
    state = (await request("session:new", "codex", child, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const canonicalChild = await realpath(child);
    assert.ok(state.terminals.some((terminal) => terminal.directory === canonicalChild));
    assert.ok(state.terminals.some((terminal) => terminal.sessionId === aider));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic native identity is persisted and ambiguous candidates cannot silently replace it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-native-binding-"));
  class Reader extends NativeSessionReader {
    records: NativeSessionRecord[] = [];
    override supports() {
      return true;
    }
    override async list() {
      return this.records;
    }
  }
  const reader = new Reader(root),
    events: string[] = [];
  const agents = {
    async refresh() {
      return terminalAgentCatalog.map((agent) => ({ ...agent, installed: true, resumable: true }));
    },
    async launch(_agent: string, id: string): Promise<TerminalLaunch> {
      return {
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        title: "Codex",
        sessionId: id,
      };
    },
  };
  const runtime = await createTerminalDesktopRuntime((event) => events.push(event), {
    store: await SqliteTerminalSessionStore.open(join(root, "state.sqlite")),
    agents,
    nativeReader: reader,
  });
  let seq = 0;
  const request = (method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++seq, method, args });
  try {
    await runtime.ready;
    let state = (await request("session:new", "codex", root, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const id = state.activeSessionId!;
    reader.records = [{ id: "native-own", createdAt: Date.now(), updatedAt: Date.now() }];
    await until(
      async () =>
        !!((await request("bootstrap")) as TerminalDesktopBootstrap).sessions[0].nativeSession,
    );
    state = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.equal(state.sessions[0].nativeSession!.id, "native-own");
    assert.ok(events.includes("sessions:changed"));
    reader.records.push(
      { id: "ambiguous-a", createdAt: Date.now(), updatedAt: Date.now() },
      { id: "ambiguous-b", createdAt: Date.now(), updatedAt: Date.now() },
    );
    await until(
      async () =>
        !((await request("bootstrap")) as TerminalDesktopBootstrap).sessions[0].nativeSession,
    );
    state = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.match(state.sessionNotices[id], /More than one native conversation/);
    await request("session:stop", id);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace archive drains agent and shell terminals, preserves session flags and restores without launching all tabs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-workspace-runtime-")));
  const store = await SqliteTerminalSessionStore.open(join(root, "state.sqlite"));
  const target = store.registerWorkspace({
    directory: root,
    repositoryPath: root,
    kind: "folder",
    managed: false,
  });
  const current = store.create(target.id, "codex");
  store.setNativeSession(current.id, { id: "native-proof" });
  const archived = store.create(target.id, "codex");
  store.archive(archived.id);
  const runtime = await createTerminalDesktopRuntime(() => {}, {
    store,
    agents: {
      async refresh() {
        return [
          {
            ...terminalAgentCatalog.find((a) => a.id === "codex")!,
            installed: true,
            resumable: true,
          },
        ];
      },
      async launch(_agent, id) {
        return {
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          title: "Fixture",
          sessionId: id,
        };
      },
    },
  });
  let counter = 0;
  const request = (method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++counter, method, args });
  try {
    await runtime.ready;
    await request("session:open", current.id);
    const shell = (await request("terminal:create", target.id)) as { id: string; pid: number };
    await request("workspace:tab", target.id, `terminal:${shell.id}`);
    await request("workspace:rename", target.id, "New name");
    await request("workspace:pin", target.id, true);
    await request("workspace:archive", target.id);
    let snapshot = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.equal(snapshot.terminals.length, 0);
    assert.equal(snapshot.activeWorkspaceId, undefined);
    assert.equal(
      snapshot.sessions.find((s) => s.id === current.id)?.nativeSession?.id,
      "native-proof",
    );
    assert.ok(snapshot.archivedSessions.find((s) => s.id === archived.id));
    assert.equal(snapshot.workspaces[0].name, "New name");
    assert.equal(snapshot.workspaces[0].pinned, true);
    assert.ok(snapshot.workspaces[0].archivedAt);
    const reopened = (await request("workspace:open", root)) as TerminalDesktopBootstrap;
    assert.equal(reopened.activeWorkspaceId, target.id);
    assert.equal(reopened.activeSessionId, undefined);
    assert.deepEqual(await request("worktrees:list", root), []);
    await assert.rejects(request("session:open", current.id), /Restore/);
    await assert.rejects(request("terminal:create", target.id), /Restore/);
    await request("workspace:restore", target.id);
    snapshot = (await request("workspace:select", target.id)) as TerminalDesktopBootstrap;
    assert.equal(snapshot.terminals.length, 0);
    assert.ok(snapshot.archivedSessions.find((s) => s.id === archived.id));
    await assert.rejects(request("workspace:tab", target.id, "terminal:foreign"), /belonging/);
    assert.throws(() => process.kill(shell.pid, 0), { code: "ESRCH" });
    const foreign = store.registerWorkspace({
      directory: join(root, "foreign"),
      repositoryPath: root,
      kind: "folder",
      managed: false,
    });
    const foreignSession = store.create(foreign.id, "codex");
    store.updateWorkspace(foreign.id, { archivedAt: Date.now() });
    store.updateWorkspace(target.id, { lastTab: `session:${foreignSession.id}` });
    const selected = (await request("workspace:select", target.id)) as TerminalDesktopBootstrap;
    assert.equal(selected.activeWorkspaceId, target.id);
    assert.equal(selected.activeSessionId, undefined);
    const external = join(root, "external-folder");
    await mkdir(external);
    const opened = (await request("workspace:open", external)) as TerminalDesktopBootstrap;
    const externalId = opened.activeWorkspaceId!;
    await rm(external, { recursive: true });
    const missing = (await request("workspace:refresh", externalId)) as TerminalDesktopBootstrap;
    assert.equal(missing.workspaces.find((w) => w.id === externalId)?.unavailable, true);
    await mkdir(external);
    const restored = (await request("workspace:refresh", externalId)) as TerminalDesktopBootstrap;
    assert.equal(restored.workspaces.find((w) => w.id === externalId)?.unavailable, false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("navigation bootstrap omits archived history and preparation bodies while detail requests preserve them", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-navigation-details-"));
  const store = await SqliteTerminalSessionStore.open(join(root, "sessions.sqlite"));
  const workspace = store.registerWorkspace({
    repositoryPath: root,
    directory: root,
    kind: "folder",
    managed: false,
  });
  const session = store.create(workspace.id, "codex");
  store.archive(session.id);
  store.saveOperation({
    id: "preparation",
    repositoryPath: root,
    directory: root,
    name: "Fixture",
    phase: "failed",
    preferences: { repositoryPath: root, setupScript: "fixture", copyPaths: [".env"] },
    copiedPaths: [".env"],
    output: "setup output",
    createdAt: 1,
  });
  const runtime = await createTerminalDesktopRuntime(() => {}, {
    store,
    agents: {
      async refresh() {
        return [];
      },
      async launch() {
        throw new Error("No agent should launch.");
      },
    },
  });
  const request = (method: string, ...args: unknown[]) => runtime.dispatch({ id: 1, method, args });
  try {
    const navigation = (await request("bootstrap", true)) as TerminalDesktopBootstrap;
    assert.deepEqual(navigation.archivedSessions, []);
    assert.equal("output" in navigation.operations[0], false);
    assert.equal("preferences" in navigation.operations[0], false);
    assert.equal(((await request("sessions:archived")) as { id: string }[])[0].id, session.id);
    assert.equal(
      ((await request("workspace:operation", "preparation")) as { output: string }).output,
      "setup output",
    );
    const complete = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.equal(complete.archivedSessions[0].id, session.id);
    await assert.rejects(request("workspace:operation", "missing"), /not found/i);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the map credits file changes to the agents working at that moment and exposes shared edits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-attribution-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  await run("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "Fixture repository\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Initial",
  ]);
  // The first agent prints continuously, so it is always working. The second is quiet until asked,
  // then announces work and writes its file while that output is still fresh.
  const write = "require('node:fs').writeFileSync(v.file,v.content)";
  const roles = [
    `setInterval(()=>console.log('tick'),60);require('node:readline').createInterface({input:process.stdin}).on('line',l=>{try{const v=JSON.parse(l);${write}}catch{}})`,
    `console.log('READY');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{try{const v=JSON.parse(l);setTimeout(()=>console.log('busy'),500);setTimeout(()=>{${write}},650)}catch{}});setInterval(()=>{},1000)`,
  ];
  let launched = 0;
  const runtime = await createTerminalDesktopRuntime(() => {}, {
    store: await SqliteTerminalSessionStore.open(join(root, "sessions.sqlite")),
    agents: {
      async refresh() {
        return terminalAgentCatalog.map((agent) => ({
          ...agent,
          installed: agent.id === "codex",
          resumable: false,
        }));
      },
      async launch(_agent, id): Promise<TerminalLaunch> {
        return {
          executable: process.execPath,
          args: ["-e", roles[launched++]],
          title: "Fixture agent",
          sessionId: id,
        };
      },
    },
    worktrees: new GitWorkspaces(join(root, "worktrees")),
  });
  let requestId = 0;
  const request = (method: string, ...args: unknown[]) =>
    runtime.dispatch({ id: ++requestId, method, args });
  const mapOf = async (id: string) =>
    (await request(
      "workspace:map",
      id,
      "working",
    )) as import("../shared/terminal-api.js").WorkspaceMap;
  try {
    await runtime.ready;
    await request("workspace:open", repo);
    let state = (await request("session:new", "codex", repo, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const first = state.sessions[0];
    state = (await request("session:new", "codex", repo, {
      kind: "folder",
    })) as TerminalDesktopBootstrap;
    const second = state.sessions.find((session) => session.id !== first.id)!;
    const ptyOf = (id: string) => state.terminals.find((terminal) => terminal.sessionId === id)!;
    assert.equal(second.workspaceId, first.workspaceId);
    const activity = async (id: string) =>
      (
        (await request("terminal:list", first.workspaceId)) as {
          sessionId?: string;
          activity: string;
        }[]
      ).find((terminal) => terminal.sessionId === id)?.activity;
    // A new terminal reports idle before its first output, so wait for READY, then for quiet.
    await until(async () =>
      ((await request("terminal:attach", ptyOf(second.id).id)) as TerminalSnapshot).buffer.includes(
        "READY",
      ),
    );
    // The quiet agent must be idle and the ticking agent working before the first edit.
    await until(async () => (await activity(second.id)) === "idle");
    assert.equal(await activity(first.id), "working");
    await request(
      "terminal:write",
      ptyOf(first.id).id,
      JSON.stringify({ file: "solo.txt", content: "one agent\n" }) + "\r",
    );
    await until(async () =>
      (await mapOf(first.id)).nodes.some((node) => node.path === "solo.txt" && node.sessions),
    );
    await request(
      "terminal:write",
      ptyOf(second.id).id,
      JSON.stringify({ file: "shared.txt", content: "both agents\n" }) + "\r",
    );
    await until(async () =>
      (await mapOf(first.id)).nodes.some(
        (node) => node.path === "shared.txt" && (node.sessions?.length ?? 0) > 0,
      ),
    );
    const map = await mapOf(first.id);
    assert.deepEqual(map.nodes.find((node) => node.path === "solo.txt")?.sessions, [first.id]);
    assert.deepEqual(
      map.nodes.find((node) => node.path === "shared.txt")?.sessions?.sort(),
      [first.id, second.id].sort(),
    );
    assert.deepEqual(map.sessions?.map((item) => item.id).sort(), [first.id, second.id].sort());
    assert.equal(
      map.nodes.find((node) => node.path === "README.md"),
      undefined,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
