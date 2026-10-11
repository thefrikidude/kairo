import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TerminalDesktopBootstrap } from "../shared/terminal-api.js";

test("workspace IPC methods cross the JSON protocol, including omitted optional arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-workspace-protocol-")),
    project = join(root, "project");
  await mkdir(project);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./protocol.js", import.meta.url))],
    {
      env: { ...process.env, KAIRO_STATE_DIR: join(root, "state") },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let counter = 0;
  const input = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.stderr.resume();
  const exited = new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code === 0) done();
      else fail(new Error(`Protocol exited ${code}`));
    });
  });
  child.once("exit", () => {
    for (const request of pending.values())
      request.reject(new Error("Protocol exited before responding"));
  });
  input.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.event === "ready") ready();
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.error) request.reject(new Error(value.error));
    else request.resolve(value.result);
  });
  const request = (method: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    });
  try {
    await Promise.race([
      started,
      exited.then(() => {
        throw new Error("Protocol never became ready");
      }),
    ]);
    const preferences = (await request("workspace:preferences", project, undefined)) as {
      setupScript: string;
    };
    assert.equal(preferences.setupScript, "");
    const state = (await request("workspace:create", {
      project,
      name: "Plain project",
      selection: { kind: "folder" },
    })) as TerminalDesktopBootstrap;
    assert.equal(state.workspaces[0].name, "Plain project");
    const id = state.workspaces[0].id;
    await request("workspace:pin", id, true);
    await request("workspace:rename", id, "Renamed");
    await request("workspace:archive", id);
    const archived = (await request("bootstrap")) as TerminalDesktopBootstrap;
    assert.ok(archived.workspaces[0].archivedAt);
    assert.equal(archived.workspaces[0].pinned, true);
    await request("workspace:restore", id);
    await request("workspace:refresh", id);
    assert.equal(
      ((await request("workspace:refs", project, undefined)) as { git: boolean }).git,
      false,
    );
    await request("shutdown");
    child.stdin.end();
    await exited;
  } finally {
    clearTimeout(timeout);
    input.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
