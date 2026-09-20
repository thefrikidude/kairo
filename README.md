# Kairo

Kairo is a terminal coding agent for a local repository. Think “one careful OpenCode-style agent”: it explores the codebase, proposes changes, asks before doing anything mutating, and helps verify the result.

It is intentionally focused on making one agent dependable before adding fancy orchestration.

## What it does

- Runs in an interactive terminal UI with streaming responses and approval prompts.
- Profiles JavaScript/TypeScript repositories, finds relevant files, and keeps context bounded.
- Reads files and searches freely inside the chosen workspace; edits, writes, and shell commands need approval.
- Suggests focused checks after edits, tracks verification, and can make a bounded repair attempt when a check fails.
- Saves resumable local sessions and metadata-only traces. No raw source, prompts, model responses, or command output are stored in traces.
- Supports Gemini, Groq, and Mistral credentials. `/auto` can choose an available model and fall back after a quota failure; manually chosen models stay manual.
- Includes deterministic and live evaluation commands for measuring the agent loop over time.

Kairo is not a full-screen TUI, plugin host, worktree manager, or multi-agent system yet. That is deliberate.

## Quick start

You’ll need Node.js 24.21+, pnpm, and an API key for Gemini, Groq, or Mistral. `kairo auth login` uses the macOS Keychain; elsewhere, use the provider environment variable.

```bash
pnpm install
pnpm build
node dist/interface/cli/index.js .
```

After installing the package, start it in any repository with:

```bash
kairo [workspace]
```

For a one-off local key, skip Keychain storage:

```bash
GEMINI_API_KEY=your_key_here node dist/interface/cli/index.js .
```

## Using it

Type normally to give Kairo a task. Type `/` in a session for the command palette.

- `/models` picks a model; `/auto` returns to automatic routing.
- `/plan` switches to a read-only planning mode. Toggle it again to build.
- `/status`, `/trace [task-id]`, and `/history` show task and session activity.
- `/verify <command>` runs a check through the regular approval flow.
- `/jev` configures the optional TypeSafe Jev decision layer. It can route requests and suggest recovery, but it never writes code or bypasses workspace restrictions. Its only optional autonomy is a high-confidence, low-risk repository-discovered verification command.

Press `y` or Enter to approve an action; press `n` or Escape to deny it. Reads are immediate. Every edit, write, and arbitrary command still asks first.

## CLI essentials

```bash
# Credentials
kairo auth login [gemini|groq|mistral]
kairo auth status

# Saved sessions
kairo sessions list
kairo resume <session-id>

# Agent-loop evaluations
kairo eval                 # deterministic fixtures
kairo eval jev             # compare fixed Jev-off/Jev-on fixtures
kairo eval live            # live Gemini + DeepEval fixtures
kairo eval self --trials 3 # real provider runs against Kairo snapshots
kairo eval history
kairo eval baseline set <run-id>
kairo eval compare <run-id>
```

`kairo eval` is a repeatable plumbing check, not a test of model intelligence. `eval self` is the capability suite: it uses isolated snapshots, seeds defects, requires Kairo to finish verified, and then runs hidden graders. Evaluation history stays sanitized—only IDs, counters, timing, pass state, and failure categories are saved.

## Development

```bash
pnpm check
pnpm test
```

The code is split into `domain`, `application`, `infrastructure`, and `interface/cli`. The core loop is bounded, workspace-confined, and approval-gated; a successful command counts as verification, not automatic proof that the task is correct.

## Direction

1. Keep the single-agent loop reliable: safe tools, repair, verification, and useful traces.
2. Improve evaluation coverage with realistic broken-repo tasks and measured reliability.
3. Later: local providers, evidence-based routing, and specialized child agents.
