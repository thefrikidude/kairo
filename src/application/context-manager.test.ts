import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  const messages = await new ContextManager(store).prepare(session.id, task);
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
  store.saveRepositorySnapshot(session.id, {
    schemaVersion: 1,
    root: "/workspace",
    fingerprint: { value: "test", kind: "filesystem" },
    entries: [],
    ecosystems: ["node"],
    changedPaths: [],
    instructionFiles: [],
    documentationFiles: [],
    manifestFiles: ["package.json"],
    ciFiles: [],
    buildFiles: [],
    truncated: false,
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
  const messages = await new ContextManager(store).prepare(session.id, task);
  assert.match(messages[0]!.content, /Package manager: pnpm/);
  assert.match(messages[0]!.content, /Available verification: test = pnpm test/);
  assert.match(messages[0]!.content, /src\/login.ts/);
  store.close();
});

test("context loads root and applicable nested instructions transiently", async () => {
  const root = await mkdtemp(join(tmpdir(), "kairo-instruction-context-"));
  await Promise.all([
    mkdir(join(root, "services", "api"), { recursive: true }),
    mkdir(join(root, "unrelated"), { recursive: true }),
    mkdir(join(root, ".github"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "AGENTS.md"), "Always run focused tests."),
    writeFile(join(root, "services", "AGENTS.md"), "Use the service conventions."),
    writeFile(join(root, "unrelated", "AGENTS.md"), "UNRELATED SECRET"),
    writeFile(join(root, ".github", "copilot-instructions.md"), `${"x".repeat(20_000)}TAIL_MARKER`),
  ]);
  const store = await SqliteSessionStore.open(":memory:");
  const session = store.create(root);
  const task = store.startTask(session.id, "Fix services api login");
  store.saveRepositorySnapshot(session.id, {
    schemaVersion: 1,
    root,
    fingerprint: { value: "test", kind: "filesystem" },
    entries: [
      { path: "AGENTS.md", kind: "instruction", size: 25, mtimeMs: 1 },
      { path: "services/AGENTS.md", kind: "instruction", size: 28, mtimeMs: 1 },
      { path: "unrelated/AGENTS.md", kind: "instruction", size: 16, mtimeMs: 1 },
      {
        path: ".github/copilot-instructions.md",
        kind: "instruction",
        size: 20_011,
        mtimeMs: 1,
      },
      { path: "services/api/login.py", kind: "source", size: 1, mtimeMs: 1 },
    ],
    ecosystems: ["python"],
    changedPaths: [],
    instructionFiles: [
      "AGENTS.md",
      ".github/copilot-instructions.md",
      "services/AGENTS.md",
      "unrelated/AGENTS.md",
    ],
    documentationFiles: [],
    manifestFiles: [],
    ciFiles: [],
    buildFiles: [],
    truncated: false,
    packageManager: "unknown",
    scripts: {},
    configFiles: [],
    sourceRoots: ["services"],
    testRoots: [],
    ignoredPaths: [],
    indexedFiles: ["services/api/login.py"],
    files: [],
    verificationCandidates: [],
    createdAt: 1,
  });
  const messages = await new ContextManager(store).prepare(session.id, task);
  assert.match(messages[0]!.content, /Always run focused tests/);
  assert.match(messages[0]!.content, /Use the service conventions/);
  assert.doesNotMatch(messages[0]!.content, /UNRELATED SECRET|TAIL_MARKER/);
  assert.doesNotMatch(JSON.stringify(store.repositorySnapshot(session.id)), /focused tests/);
  store.close();
});
