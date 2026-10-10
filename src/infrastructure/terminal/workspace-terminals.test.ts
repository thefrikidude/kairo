import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTerminals } from "./workspace-terminals.js";
import { terminalProcesses } from "./terminal-processes.js";
import type { TerminalData } from "../../domain/workspace-terminal.js";

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal output.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("native workspace terminals preserve cwd, ANSI, input, resize and independent tabs", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-terminal-")));
  const events: TerminalData[] = [];
  const service = new WorkspaceTerminals(
    (event, payload) => {
      if (event === "terminal:data") events.push(payload as TerminalData);
    },
    { shell: "/bin/zsh", args: ["-f"], env: { PS1: "KAIRO_READY> " } },
  );
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const [first, reused] = await Promise.all([
    service.create("one", root, true),
    service.create("one", root, true),
  ]);
  assert.equal(first.id, reused.id);
  await waitUntil(() => service.attach(first.id).buffer.includes("KAIRO_READY>"));
  service.resize(first.id, 101, 37);
  service.input(first.id, "printf '\\033[32mCOLOR_OK\\033[0m\\n'; pwd; stty size\r");
  await waitUntil(() => service.attach(first.id).buffer.includes("37 101"));
  const output = service.attach(first.id);
  assert.ok(output.buffer.includes(root));
  assert.ok(output.buffer.includes("\x1b[32mCOLOR_OK\x1b[0m"));
  service.input(first.id, "sleep 120\r");
  let foreground = 0;
  await waitUntil(async () => {
    foreground =
      (await terminalProcesses()).find((row) => row.parent === first.pid && !row.zombie)?.pid ?? 0;
    return foreground > 0;
  });
  service.input(first.id, "\x03");
  await waitUntil(
    async () => !(await terminalProcesses()).some((row) => row.pid === foreground && !row.zombie),
  );
  assert.equal(service.list("one")[0].state, "running");
  const second = await service.create("two", root);
  assert.notEqual(second.pid, first.pid);
  await waitUntil(() => service.attach(second.id).buffer.includes("KAIRO_READY>"));
  service.input(second.id, "echo SECOND_TAB\r");
  await waitUntil(() => service.attach(second.id).buffer.includes("SECOND_TAB\r\n"));
  assert.ok(!service.attach(first.id).buffer.includes("SECOND_TAB"));
  assert.throws(() => service.resize(first.id, NaN, 20), /dimensions/);
  assert.throws(() => service.resize(first.id, 80, 201), /dimensions/);
  assert.throws(() => service.input(first.id, "x".repeat(32_001)), /32,000/);
  assert.throws(() => service.acknowledge(first.id, output.sequence + 100), /acknowledgement/);
  service.detach(first.id);
  service.input(first.id, "printf 'REPLAY_OK\\n'\r");
  await waitUntil(() => service.attach(first.id).buffer.includes("REPLAY_OK\r\n"));
  await service.closeTerminal(first.id);
  assert.deepEqual(service.list("one"), []);
  assert.equal(service.list("two")[0].state, "running");
  assert.ok(events.length > 0);
  await service.close();
  assert.deepEqual(service.list(), []);
  await assert.rejects(service.create("one", root), /shutting down/);
});

test("closing a terminal stops foreground child processes without cancelling other shells", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-terminal-processes-")));
  const service = new WorkspaceTerminals(() => {}, {
    shell: "/bin/zsh",
    args: ["-f"],
    env: { PS1: "KAIRO_READY> " },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await service.create("one", root);
  const second = await service.create("two", root);
  await waitUntil(() => service.attach(first.id).buffer.includes("KAIRO_READY>"));
  service.input(first.id, "sleep 120 & echo CHILD_PID:$!; wait\r");
  let child = 0;
  await waitUntil(() => {
    const match = service.attach(first.id).buffer.match(/CHILD_PID:(\d+)/);
    child = Number(match?.[1]);
    return child > 0;
  });
  assert.ok((await terminalProcesses()).some((row) => row.pid === child && !row.zombie));
  await service.closeTerminal(first.id);
  assert.ok(!(await terminalProcesses()).some((row) => row.pid === child && !row.zombie));
  assert.ok((await terminalProcesses()).some((row) => row.pid === second.pid && !row.zombie));
  await service.close();
  assert.ok(!(await terminalProcesses()).some((row) => row.pid === second.pid && !row.zombie));
});

test("shutdown drains terminal creation already in flight", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-terminal-close-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceTerminals(() => {}, { shell: "/bin/zsh", args: ["-f"] });
  const creating = service.create("one", root);
  const rejected = assert.rejects(creating, /shutting down/);
  await service.close();
  await rejected;
  assert.deepEqual(service.list(), []);
});

test("terminal output is bounded and resumes after renderer acknowledgement", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-terminal-flow-")));
  const packets: TerminalData[] = [];
  let autoAck = false;
  const service = new WorkspaceTerminals(
    (event, value) => {
      if (event !== "terminal:data") return;
      const packet = value as TerminalData;
      packets.push(packet);
      if (autoAck) service.acknowledge(packet.id, packet.sequence);
    },
    { shell: "/bin/zsh", args: ["-f"], env: { PS1: "KAIRO_READY> " } },
  );
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const terminal = await service.create("one", root);
  await waitUntil(() => service.attach(terminal.id).buffer.includes("KAIRO_READY>"));
  packets.length = 0;
  service.input(
    terminal.id,
    'node -e \'process.stdout.write("x".repeat(500000)+"FLOW_DONE\\n")\'\r',
  );
  await waitUntil(() => packets.reduce((size, packet) => size + packet.data.length, 0) >= 128_000);
  await new Promise((done) => setTimeout(done, 100));
  assert.ok(packets.reduce((size, packet) => size + packet.data.length, 0) < 500_000);
  autoAck = true;
  service.acknowledge(terminal.id, packets.at(-1)!.sequence);
  await waitUntil(() => packets.some((packet) => packet.data.includes("FLOW_DONE\r\n")));
  const snapshot = service.attach(terminal.id);
  assert.ok(snapshot.buffer.length <= 128_000);
  assert.ok(snapshot.buffer.includes("FLOW_DONE\r\n"));
});

test("agent sessions retain shell job control, literal argv and distinct durable identities", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kairo-agent-terminal-")));
  const service = new WorkspaceTerminals(() => {}, {
    shell: "/bin/zsh",
    args: ["-f"],
    env: { PS1: "KAIRO_READY> " },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const literal = "$(touch SHOULD_NOT_EXIST); words 'quoted'";
  const launch = {
    executable: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),fixture:process.env.KAIRO_AGENT_FIXTURE}));setInterval(()=>{},1000)",
      literal,
    ],
    title: "Fixture agent",
    sessionId: "session-a",
    env: { KAIRO_AGENT_FIXTURE: "ready" },
  };
  const [first, duplicate] = await Promise.all([
    service.createAgent("workspace-a", root, launch),
    service.createAgent("workspace-a", root, launch),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.sessionId, "session-a");
  await waitUntil(() => service.attach(first.id).buffer.includes('"fixture":"ready"'));
  const output = JSON.parse(
    service
      .attach(first.id)
      .buffer.split(/\r?\n/)
      .find((line) => line.startsWith('{"cwd":'))!,
  );
  assert.equal(output.cwd, root);
  assert.deepEqual(output.args, [literal]);
  await assert.rejects(access(join(root, "SHOULD_NOT_EXIST")));
  // Use shell suspends the foreground CLI without destroying its conversation.
  service.input(first.id, "\x1a");
  await waitUntil(() => service.attach(first.id).buffer.includes("suspended"));
  service.input(first.id, "printf 'SHELL_%s\\n' READY; pwd\r");
  await waitUntil(() => service.attach(first.id).buffer.includes("SHELL_READY\r\n"));
  service.input(first.id, "fg\r");
  await new Promise((done) => setTimeout(done, 100));
  service.input(first.id, "\x03");
  service.input(first.id, "printf 'AFTER_%s\\n' EXIT\r");
  await waitUntil(() => service.attach(first.id).buffer.includes("AFTER_EXIT\r\n"));
  assert.equal(service.list()[0].state, "running");
  const second = await service.createAgent("workspace-a", root, {
    ...launch,
    args: ["-e", "console.log('AGENT_FINISHED')"],
    sessionId: "session-b",
  });
  await waitUntil(() => service.attach(second.id).buffer.includes("AGENT_FINISHED\r\n"));
  await new Promise((done) => setTimeout(done, 100));
  service.input(second.id, "printf 'NORMAL_%s\\n' SHELL\r");
  await waitUntil(() => service.attach(second.id).buffer.includes("NORMAL_SHELL\r\n"));
  await assert.rejects(
    service.createAgent("workspace-a", root, {
      ...launch,
      sessionId: "unsafe",
      args: ["bad\x03argument"],
    }),
    /control characters/,
  );
  assert.equal(service.list().length, 2);
  assert.notEqual(first.pid, second.pid);
  await service.closeTerminal(first.id);
  assert.equal(service.list()[0].sessionId, "session-b");
  await service.close();
  assert.ok(
    !(await terminalProcesses()).some(
      (row) => [first.pid, second.pid].includes(row.pid) && !row.zombie,
    ),
  );
});
