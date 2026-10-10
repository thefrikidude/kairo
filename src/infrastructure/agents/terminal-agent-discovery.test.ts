import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalAgentDiscovery } from "./terminal-agent-discovery.js";
import { terminalAgentCatalog, nativeResumeArgs } from "./terminal-agent-catalog.js";

test("full CLI catalog uses installation aliases, requires dependencies and refreshes before launch", async () => {
  const home = await mkdtemp(join(tmpdir(), "kairo-cli-discovery-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  const add = async (name: string) => {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, name), 0o755);
  };
  const discovery = new TerminalAgentDiscovery({ path: bin, home });
  try {
    await add("cbc");
    await add("dst");
    await mkdir(join(bin, "codex")); // An executable directory is not an installed CLI.
    let agents = await discovery.refresh();
    assert.equal(agents.length, 45);
    assert.equal(new Set(agents.map((agent) => agent.id)).size, 45);
    assert.ok(terminalAgentCatalog.every((agent) => agent.homepage.startsWith("https://")));
    assert.equal(agents.find((agent) => agent.id === "codebuddy")!.executable, join(bin, "cbc"));
    assert.equal(agents.find((agent) => agent.id === "dsh")!.installed, false);
    assert.equal(agents.find((agent) => agent.id === "codex")!.installed, false);
    await add("dsh");
    agents = await discovery.refresh();
    assert.equal(agents.find((agent) => agent.id === "dsh")!.installed, true);
    const launch = await discovery.launch("codebuddy", "session-a", { id: "native-a" });
    assert.deepEqual(launch.args, ["--resume", "native-a"]);
    assert.equal(launch.sessionId, "session-a");
    await rm(join(bin, "cbc"));
    await assert.rejects(discovery.launch("codebuddy", "session-a"), /Install CodeBuddy/);
    await assert.rejects(discovery.launch("arbitrary", "session-a"), /supported terminal agent/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resume targets remain exact and invalid IDs or missing transcript locators are refused", () => {
  assert.deepEqual(nativeResumeArgs("codex", { id: "session-123" }), ["resume", "session-123"]);
  assert.deepEqual(nativeResumeArgs("opencode", { id: "ses_123" }), ["--session", "ses_123"]);
  assert.deepEqual(nativeResumeArgs("copilot", { id: "123" }), ["--resume=123"]);
  assert.deepEqual(nativeResumeArgs("pi", { id: "abc", transcriptPath: "/tmp/session.jsonl" }), [
    "--session",
    "/tmp/session.jsonl",
  ]);
  assert.throws(() => nativeResumeArgs("pi", { id: "abc" }), /transcript path/);
  assert.throws(() => nativeResumeArgs("codex", { id: "--last" }), /Invalid/);
  assert.throws(() => nativeResumeArgs("codex", { id: "abc\nmore" }), /Invalid/);
  assert.throws(() => nativeResumeArgs("aider", { id: "abc" }), /does not support/);
  assert.equal(
    terminalAgentCatalog.find((agent) => agent.id === "claude-agent-teams")!.commands[0],
    "claude",
  );
  assert.ok(
    !terminalAgentCatalog.some((agent) =>
      agent.args.some((arg) => arg.includes("bypass") || arg.includes("trust")),
    ),
  );
});

test("CLI-native pickers are explicit and never use a global last-session shortcut", async () => {
  const home = await mkdtemp(join(tmpdir(), "kairo-cli-picker-")),
    bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const discovery = new TerminalAgentDiscovery({ path: bin, home });
    const launch = await discovery.launch(
      "codex",
      "kairo-session",
      undefined,
      true,
      "/tmp/workspace with spaces",
    );
    assert.deepEqual(launch.args, ["resume", "--cd", "/tmp/workspace with spaces"]);
    assert.ok(!launch.args.includes("--last"));
    assert.equal(
      (await discovery.refresh()).find((agent) => agent.id === "codex")!.resumePicker,
      true,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
