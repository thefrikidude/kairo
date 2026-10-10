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
