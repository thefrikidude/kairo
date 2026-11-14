import assert from "node:assert/strict";
import test from "node:test";
import { detectAgent } from "./agent-detect.js";

const agents = [
  { id: "claude", name: "Claude", commands: ["claude"] },
  { id: "claude-teams", name: "Claude Agent Teams", commands: ["claude"] },
  { id: "codex", name: "Codex", commands: ["codex"] },
  { id: "opencode", name: "OpenCode", commands: ["opencode"] },
];

test("recognises an agent by its command, path or interpreter script", () => {
  assert.equal(detectAgent("claude --resume abc", agents)?.id, "claude");
  assert.equal(detectAgent("/Users/me/.local/share/claude/versions/2.1.0", agents)?.id, "claude");
  assert.equal(
    detectAgent("node /usr/lib/node_modules/@openai/codex/bin/codex.js", agents)?.id,
    "codex",
  );
  assert.equal(detectAgent("-zsh", agents), undefined);
  assert.equal(detectAgent("vim notes.txt", agents), undefined);
  assert.equal(detectAgent(undefined, agents), undefined);
});

test("a path argument to another program is not mistaken for an agent", () => {
  assert.equal(detectAgent("vim /home/me/codex/readme.md", agents), undefined);
  assert.equal(detectAgent("git log opencode", agents), undefined);
});

test("shared commands resolve to the agent the workspace already used", () => {
  assert.equal(detectAgent("claude", agents)?.id, "claude");
  assert.equal(detectAgent("claude", agents, ["claude-teams"])?.id, "claude-teams");
});
