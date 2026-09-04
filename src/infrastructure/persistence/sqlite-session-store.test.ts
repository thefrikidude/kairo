import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import type { RepositoryProfile } from "../../domain/models.js";

test("sessions persist messages and sort by latest activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-store-"));
  const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  store.addMessage(session.id, { role: "user", content: "hello", createdAt: 1 });
  assert.equal(store.get(session.id)?.workspace, "/workspace");
  assert.deepEqual(
    store.messages(session.id).map((item) => item.content),
    ["hello"],
  );
  assert.equal(store.list()[0]?.id, session.id);
  store.close();
});

test("active tasks recover as interrupted after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-recover-"));
  const path = join(dir, "sessions.sqlite");
  const first = await SqliteSessionStore.open(path);
  const session = first.create("/workspace");
  const task = first.startTask(session.id, "repair tests");
  first.updateTask(task.id, { status: "acting" });
  first.close();
  const restarted = await SqliteSessionStore.open(path);
  assert.equal(restarted.task(task.id)?.status, "interrupted");
  restarted.close();
});

test("repository profiles persist for resumed sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-profile-store-"));
  const path = join(dir, "sessions.sqlite");
  const profile: RepositoryProfile = {
    root: "/workspace",
    packageManager: "pnpm",
    scripts: { test: "node --test" },
    configFiles: ["tsconfig.json"],
    sourceRoots: ["src"],
    testRoots: ["test"],
    ignoredPaths: ["node_modules"],
    indexedFiles: ["src/index.ts"],
    verificationCandidates: [{ label: "test", command: "pnpm test" }],
    createdAt: 1,
  };
  const first = await SqliteSessionStore.open(path);
  const session = first.create("/workspace");
  first.saveRepositoryProfile(session.id, profile);
  first.close();
  const restarted = await SqliteSessionStore.open(path);
  assert.deepEqual(restarted.repositoryProfile(session.id), profile);
  restarted.close();
});
