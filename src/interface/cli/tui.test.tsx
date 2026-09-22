import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import {
  BrandMark,
  changedFileReview,
  inlineDiff,
  ModeBadge,
  TranscriptRow,
  TuiApproval,
  interactionModeAfterCommand,
  interactionModeAfterTask,
  matchingSlashCommands,
  modelOptions,
} from "./tui.js";

function git(workspace: string, args: string[]): void {
  execFileSync(process.platform === "darwin" ? "/usr/bin/git" : "git", args, {
    cwd: workspace,
    stdio: "ignore",
  });
}

test("plan command toggles the live interaction mode", () => {
  assert.equal(interactionModeAfterCommand("build", "/plan"), "plan");
  assert.equal(interactionModeAfterCommand("plan", "/plan"), "build");
  assert.equal(interactionModeAfterCommand("plan", "/status"), "plan");
});

test("a Jev planning task leaves the composer in PLAN mode", () => {
  assert.equal(interactionModeAfterTask("build", "planning"), "plan");
  assert.equal(interactionModeAfterTask("plan", "implementation"), "plan");
  assert.equal(interactionModeAfterTask("build", "implementation"), "build");
});

test("mode badge renders the active plan and build states", () => {
  const view = render(<ModeBadge mode="plan" />);
  assert.match(view.lastFrame() ?? "", /PLAN/);
  view.rerender(<ModeBadge mode="build" />);
  assert.match(view.lastFrame() ?? "", /BUILD/);
});

test("brand mark renders the large Kairo start-screen identity", () => {
  const view = render(<BrandMark />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /██/);
  assert.equal(frame.split("\n").length, 6);
});

test("transcript rows clearly separate the speaker from the message", () => {
  const view = render(
    <TranscriptRow entry={{ id: 1, kind: "assistant", text: "I found the failing test." }} />,
  );
  assert.match(view.lastFrame() ?? "", /KAIRO/);
  assert.match(view.lastFrame() ?? "", /I found the failing test\./);

  view.rerender(<TranscriptRow entry={{ id: 2, kind: "user", text: "Fix it" }} />);
  assert.match(view.lastFrame() ?? "", /YOU/);
  assert.match(view.lastFrame() ?? "", /Fix it/);
});

test("an empty assistant row renders an animated response indicator", () => {
  const view = render(<TranscriptRow entry={{ id: 1, kind: "assistant", text: "" }} />);
  assert.match(view.lastFrame() ?? "", /Generating response/);
  view.unmount();
});

test("changed-file review shows the working-tree patch for a file Kairo touched", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kairo-changes-"));
  try {
    git(workspace, ["init"]);
    git(workspace, ["config", "user.email", "kairo@example.test"]);
    git(workspace, ["config", "user.name", "Kairo Test"]);
    await writeFile(join(workspace, "app.ts"), "export const value = 1;\n");
    git(workspace, ["add", "app.ts"]);
    git(workspace, ["commit", "-m", "initial"]);
    await writeFile(join(workspace, "app.ts"), "export const value = 2;\n");

    const review = changedFileReview(workspace, "app.ts");
    assert.match(review.diff, /-export const value = 1;/);
    assert.match(review.diff, /\+export const value = 2;/);
    assert.equal(review.unavailable, undefined);

    await rm(join(workspace, "app.ts"));
    const deleted = changedFileReview(workspace, "app.ts");
    assert.match(deleted.diff, /deleted file mode/);
    assert.match(deleted.diff, /-export const value = 1;/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("changed-file review renders untracked files as additions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "kairo-changes-"));
  try {
    git(workspace, ["init"]);
    await writeFile(join(workspace, "new.txt"), "created by Kairo\n");

    const review = changedFileReview(workspace, "new.txt");
    assert.match(review.diff, /\+created by Kairo/);
    assert.equal(review.unavailable, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inline diffs retain Codex-style line metadata and change counts", () => {
  const diff = inlineDiff({
    path: "hello.txt",
    diff: [
      "diff --git a/hello.txt b/hello.txt",
      "index 1111111..2222222 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,2 +1,3 @@",
      " moonlit circuits",
      "-old signal",
      "+new signal",
      "+violet sky",
      "",
    ].join("\n"),
  });

  assert.ok(diff);
  assert.equal(diff.path, "hello.txt");
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 1);
  assert.deepEqual(diff.hunks[0]?.lines, [
    { kind: "context", oldLine: 1, newLine: 1, text: "moonlit circuits" },
    { kind: "deletion", oldLine: 2, text: "old signal" },
    { kind: "addition", newLine: 2, text: "new signal" },
    { kind: "addition", newLine: 3, text: "violet sky" },
  ]);
});

test("inline diffs retain every line in a long patch", () => {
  const additions = Array.from({ length: 300 }, (_, index) => `+line ${index + 1}`);
  const diff = inlineDiff({
    path: "long.txt",
    diff: [
      "diff --git a/long.txt b/long.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/long.txt",
      "@@ -0,0 +1,300 @@",
      ...additions,
      "",
    ].join("\n"),
  });

  assert.ok(diff);
  assert.equal(diff.additions, 300);
  assert.equal(diff.hunks[0]?.lines.length, 300);
  assert.deepEqual(diff.hunks[0]?.lines.at(-1), {
    kind: "addition",
    newLine: 300,
    text: "line 300",
  });
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
