import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionReader, freshNativeCandidates } from "./native-session-reader.js";

test("Codex capture reads native IDs/recency only and excludes other roots, child agents and pre-launch sessions", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "kairo-native-codex-")));
  const codex = join(home, ".codex"),
    repo = join(home, "repo");
  await mkdir(codex);
  await mkdir(repo);
  const path = join(codex, "state_5.sqlite"),
    db = new Database(path),
    since = Date.now();
  db.exec(
    "CREATE TABLE threads(id TEXT,cwd TEXT,source TEXT,rollout_path TEXT,created_at_ms INTEGER,updated_at_ms INTEGER,recency_at_ms INTEGER,archived INTEGER,first_user_message TEXT)",
  );
  const insert = (
    id: string,
    cwd: string,
    source: string,
    created: number,
    updated: number,
    archived = 0,
  ) =>
    db
      .prepare(
        "INSERT INTO threads(id,cwd,source,rollout_path,created_at_ms,updated_at_ms,recency_at_ms,archived,first_user_message) VALUES(?,?,?,NULL,?,?,?,?,'private conversation')",
      )
      .run(id, cwd, source, created, updated, updated, archived);
  insert("old", repo, "cli", since - 5000, since - 5000);
  insert("already-live", repo, "cli", since - 100, since - 100);
  const reader = new NativeSessionReader(home),
    lookup = { agentId: "codex", directory: repo, since, env: { CODEX_HOME: codex } };
  try {
    const baseline = new Map((await reader.list(lookup)).map((row) => [row.id, row.updatedAt]));
    insert("new", repo, "cli", since + 10, since + 10);
    insert("other-root", home, "cli", since + 10, since + 10);
    insert("child", repo, '{"subagent":"review"}', since + 10, since + 10);
    insert("archived", repo, "cli", since + 10, since + 10, 1);
    const records = await reader.list(lookup),
      fresh = freshNativeCandidates(records, baseline);
    assert.deepEqual(
      fresh.map((record) => record.id),
      ["new"],
    );
    assert.equal(JSON.stringify(records).includes("private conversation"), false);
    assert.deepEqual(Object.keys(fresh[0]).sort(), ["createdAt", "id", "updatedAt"]);
    // A native picker can select an older record whose recency changed during this launch.
    db.prepare("UPDATE threads SET recency_at_ms=? WHERE id='old'").run(since + 100);
    const picker = await reader.list({ ...lookup, includeExisting: true });
    assert.ok(picker.some((row) => row.id === "old"));
    assert.ok(
      freshNativeCandidates(picker, new Map(picker.map((row) => [row.id, row.updatedAt])), true)
        .length === 0,
    );
    // Current Codex TUI shares the desktop daemon: its user roots are recorded as vscode.
    db.exec("ALTER TABLE threads ADD COLUMN thread_source TEXT");
    insert("shared-daemon", repo, "vscode", since + 30, since + 30);
    db.prepare("UPDATE threads SET thread_source='user' WHERE id='shared-daemon'").run();
    insert("not-a-user-root", repo, "vscode", since + 30, since + 30);
    db.prepare("UPDATE threads SET thread_source='subagent' WHERE id='not-a-user-root'").run();
    const shared = await reader.list(lookup);
    assert.ok(shared.some((record) => record.id === "shared-daemon"));
    assert.ok(!shared.some((record) => record.id === "not-a-user-root"));
    baseline.set("shared-daemon", since + 30);
    insert("also-new", repo, "cli", since + 20, since + 20);
    assert.equal(freshNativeCandidates(await reader.list(lookup), baseline).length, 2); // Caller must refuse ambiguity.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM threads").get() &&
        (db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count,
      9,
    );
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenCode capture honors its database selection and ignores nested agent sessions", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "kairo-native-opencode-"))),
    repo = join(home, "repo"),
    path = join(home, "selected.db"),
    since = Date.now();
  await mkdir(repo);
  const db = new Database(path);
  db.exec(
    "CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER)",
  );
  const add = (id: string, parent: string | null, dir = repo) =>
    db.prepare("INSERT INTO session VALUES(?,?,?,?,?,NULL)").run(id, dir, parent, since, since);
  add("ses_root", null);
  add("ses_child", "ses_root");
  add("ses_elsewhere", null, home);
  const reader = new NativeSessionReader(home);
  try {
    const records = await reader.list({
      agentId: "opencode",
      directory: repo,
      since,
      env: { OPENCODE_DB: path },
    });
    assert.deepEqual(
      records.map((row) => row.id),
      ["ses_root"],
    );
    assert.deepEqual(
      await reader.list({
        agentId: "opencode",
        directory: repo,
        since,
        env: { OPENCODE_DB: ":memory:" },
      }),
      [],
    );
    assert.equal(reader.supports("aider"), false);
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy Codex metadata fallback is bounded and checks cwd, source and launch time", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "kairo-native-rollout-"))),
    repo = join(home, "repo"),
    codex = join(home, "codex"),
    since = Date.now();
  await mkdir(repo);
  const folder = join(codex, "sessions", ...new Date().toISOString().slice(0, 10).split("-"));
  await mkdir(folder, { recursive: true });
  const add = (file: string, id: string, cwd: string, source: string) =>
    writeFile(
      join(folder, file),
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: { id, cwd, source },
      }) +
        "\n" +
        "private message not needed\n",
    );
  await add("rollout.jsonl", "own", repo, "cli");
  await add("outside.jsonl", "foreign", home, "cli");
  await add("subagent.jsonl", "child", repo, "subagent");
  await add("bad.jsonl", "--last", repo, "cli");
  try {
    const records = await new NativeSessionReader(home).list({
      agentId: "codex",
      directory: repo,
      since,
      env: { CODEX_HOME: codex },
    });
    assert.deepEqual(
      records.map((row) => row.id),
      ["own"],
    );
    assert.equal(records[0].transcriptPath, join(folder, "rollout.jsonl"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
