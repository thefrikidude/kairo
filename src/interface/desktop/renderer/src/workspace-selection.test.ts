import test from "node:test";
import assert from "node:assert/strict";
import { rememberedShell, openWorkspaceShell } from "./workspace-selection.js";
import type { WorkspaceTerminal } from "../../shared/terminal-api.js";

const shell: WorkspaceTerminal = {
  id: "shell-a",
  workspaceId: "a",
  directory: "/a",
  title: "Shell",
  pid: 1,
  state: "running",
  columns: 80,
  rows: 24,
};

test("remembered shell selection follows tab changes and refuses foreign, missing and agent tabs", () => {
  const second = { ...shell, id: "shell-b" };
  const terminals = [shell, second, { ...shell, id: "agent", sessionId: "session" }];
  assert.equal(rememberedShell("a", "terminal:shell-a", terminals), "shell-a");
  assert.equal(rememberedShell("a", "terminal:shell-b", terminals), "shell-b");
  assert.equal(rememberedShell("b", "terminal:shell-a", terminals), undefined);
  assert.equal(rememberedShell("a", "terminal:missing", terminals), undefined);
  assert.equal(rememberedShell("a", "terminal:agent", terminals), undefined);
  assert.equal(rememberedShell("a", "session:session", terminals), undefined);
});

test("shell creation finishing after navigation registers its terminal without changing selection", async () => {
  let finish!: (terminal: WorkspaceTerminal) => void;
  let current = true;
  const received: WorkspaceTerminal[] = [];
  const selected: WorkspaceTerminal[] = [];
  const remembered: string[] = [];
  const opening = openWorkspaceShell(
    {
      createTerminal: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      rememberWorkspaceTab: async (id, tab) => {
        remembered.push(`${id}/${tab}`);
      },
    },
    "a",
    (terminal) => received.push(terminal),
    () => current,
    (terminal) => selected.push(terminal),
  );
  current = false;
  finish(shell);
  await opening;
  assert.deepEqual(received, [shell]);
  assert.deepEqual(selected, []);
  assert.deepEqual(remembered, []);
});

test("shell creation selects and remembers the current workspace, but ignores a newer selection during persistence", async () => {
  let current = true;
  const selected: WorkspaceTerminal[] = [];
  const api = {
    createTerminal: async () => shell,
    rememberWorkspaceTab: async (id: string, tab: string) => {
      assert.equal(id, "a");
      assert.equal(tab, "terminal:shell-a");
    },
  };
  await openWorkspaceShell(
    api,
    "a",
    () => {},
    () => current,
    (terminal) => selected.push(terminal),
  );
  assert.deepEqual(selected, [shell]);
  selected.length = 0;
  await openWorkspaceShell(
    {
      ...api,
      rememberWorkspaceTab: async () => {
        current = false;
      },
    },
    "a",
    () => {},
    () => current,
    (terminal) => selected.push(terminal),
  );
  assert.deepEqual(selected, []);
});
