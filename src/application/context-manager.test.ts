import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "./context-manager.js";
import { SqliteSessionStore } from "../infrastructure/persistence/sqlite-session-store.js";

test("context compacts long history into a durable checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-context-"));
  const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  const task = store.startTask(session.id, "understand the project");
  for (let index = 0; index < 50; index += 1)
    store.addMessage(session.id, {
      role: "user",
      content: `message ${index}`,
      createdAt: index,
    });
  const messages = new ContextManager(store).prepare(session.id, task);
  assert.ok(store.latestCheckpoint(session.id));
  assert.ok(messages.length <= 33);
  assert.match(messages[0]!.content, /Context checkpoint/);
  store.close();
});

test("context begins with the persisted repository profile and verification guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kairo-profile-context-"));
  const store = await SqliteSessionStore.open(join(dir, "sessions.sqlite"));
  const session = store.create("/workspace");
  const task = store.startTask(session.id, "Fix login validation");
  store.saveRepositoryProfile(session.id, {
    root: "/workspace",
    packageManager: "pnpm",
    scripts: { test: "node --test" },
    configFiles: ["tsconfig.json"],
    sourceRoots: ["src"],
    testRoots: ["tests"],
    ignoredPaths: ["node_modules"],
    indexedFiles: ["src/login.ts", "tests/login.test.ts"],
    files: [],
    verificationCandidates: [{ label: "test", command: "pnpm test" }],
    createdAt: 1,
  });
  const messages = new ContextManager(store).prepare(session.id, task);
  assert.match(messages[0]!.content, /Package manager: pnpm/);
  assert.match(messages[0]!.content, /Recommended verification: test = pnpm test/);
  assert.match(messages[0]!.content, /src\/login.ts/);
  store.close();
});
