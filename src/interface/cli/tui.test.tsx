import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import {
  ModeBadge,
  TuiApproval,
  interactionModeAfterCommand,
  matchingSlashCommands,
  modelOptions,
} from "./tui.js";

test("plan command toggles the live interaction mode", () => {
  assert.equal(interactionModeAfterCommand("build", "/plan"), "plan");
  assert.equal(interactionModeAfterCommand("plan", "/plan"), "build");
  assert.equal(interactionModeAfterCommand("plan", "/status"), "plan");
});

test("mode badge renders the active plan and build states", () => {
  const view = render(<ModeBadge mode="plan" />);
  assert.match(view.lastFrame() ?? "", /PLAN/);
  view.rerender(<ModeBadge mode="build" />);
  assert.match(view.lastFrame() ?? "", /BUILD/);
});

test("model picker lists every registered model", () => {
  assert.deepEqual(
    modelOptions().map(({ provider, model }) => `${provider}/${model}`),
    [
      "gemini/gemini-2.5-flash",
      "groq/openai/gpt-oss-120b",
      "groq/openai/gpt-oss-20b",
      "mistral/mistral-small-latest",
      "mistral/mistral-medium-latest",
    ],
  );
});

test("slash-command palette filters names and hides after an argument begins", () => {
  assert.deepEqual(
    matchingSlashCommands("/ver").map((command) => command.name),
    ["/verify"],
  );
  assert.deepEqual(matchingSlashCommands("/resume session-id"), []);
  assert.deepEqual(
    matchingSlashCommands("/jev").map((command) => command.name),
    ["/jev"],
  );
  assert.deepEqual(
    matchingSlashCommands("/aut").map((command) => command.name),
    ["/auto"],
  );
});

test("TUI approval waits for and returns the user's decision", async () => {
  let pending: { resolve: (approved: boolean) => void } | undefined;
  const approval = new TuiApproval((request) => {
    pending = request;
  });
  const result = approval.approve({ id: "call", name: "write_file", args: {} }, "Write file");
  assert.ok(pending);
  pending.resolve(true);
  assert.equal(await result, true);
});
