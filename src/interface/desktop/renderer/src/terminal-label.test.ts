import assert from "node:assert/strict";
import test from "node:test";
import { shellLabels } from "./terminal-label.js";
import type { WorkspaceTerminal } from "../../shared/api.js";

const shell = (id: string, workspaceId: string, extra: Partial<WorkspaceTerminal> = {}) =>
  ({
    id,
    workspaceId,
    directory: "/x",
    title: "zsh",
    pid: 1,
    state: "running",
    activity: "idle",
    columns: 80,
    rows: 24,
    ...extra,
  }) as WorkspaceTerminal;

test("shells are numbered per workspace and keep names the user chose", () => {
  const labels = shellLabels([
    shell("a", "one"),
    shell("agent", "one", { sessionId: "s" }),
    shell("b", "one", { named: true, title: "Build server" }),
    shell("c", "one"),
    shell("d", "two"),
  ]);
  assert.equal(labels.get("a"), "Terminal 1");
  assert.equal(labels.has("agent"), false);
  assert.equal(labels.get("b"), "Build server");
  assert.equal(labels.get("c"), "Terminal 3");
  assert.equal(labels.get("d"), "Terminal 1");
});
