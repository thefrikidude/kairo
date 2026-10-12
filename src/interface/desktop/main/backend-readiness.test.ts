import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { backendReadiness } from "./backend-readiness.js";

test("missing backend executable rejects readiness on the spawn error without waiting for timeout", async () => {
  const child = spawn(`/kairo-missing-node-${process.pid}`, [], { stdio: "pipe" });
  const readiness = backendReadiness(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        readiness.ready,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Readiness still pending after spawn failure")),
            1_000,
          );
        }),
      ]),
      /ENOENT/,
    );
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    clearTimeout(timer);
  }
});

test("early backend exit rejects readiness and removes startup listeners", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "pipe" });
  await assert.rejects(backendReadiness(child).ready, /exited before it was ready/);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("successful readiness clears startup listeners while the backend remains running", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "pipe" });
  const closed = once(child, "close");
  try {
    const readiness = backendReadiness(child);
    readiness.succeed();
    await readiness.ready;
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("error"), 1); // once(close) owns its error listener.
  } finally {
    child.kill();
    await closed;
  }
});

test("startup timeout clears listeners and explicit readiness errors retain their message", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "pipe" });
  const closed = once(child, "close");
  try {
    await assert.rejects(backendReadiness(child, 10).ready, /did not start in time/);
    const readiness = backendReadiness(child);
    readiness.fail(new Error("Database unavailable"));
    await assert.rejects(readiness.ready, /Database unavailable/);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    child.kill();
    await closed;
  }
});
