# Kairo
<img width="1159" height="677" alt="Screenshot 2026-09-21 at 12 02 14 PM" src="https://github.com/user-attachments/assets/85024d79-f167-4f9d-a80a-3c2fccb74bba" />


Kairo is a terminal coding agent for a local repository. It understands the codebase, plans or implements a change, asks before doing anything mutating, and verifies the result.

The focus is reliability, not agent theatre. Kairo keeps one bounded loop, safe workspace tools, resumable sessions, useful traces, and honest verification state.

## What it does

- Runs in a full-screen Ink TUI with streaming responses, a task timeline, slash-command palette, and approval cards.
- Builds a language-neutral repository snapshot, enriches JavaScript/TypeScript structure, ranks relevant files, and keeps model context bounded.
- Reads and searches freely inside the workspace. Edits, writes, and arbitrary shell commands require approval.
- Recommends focused checks after changes and can make bounded repair attempts when verification fails.
- Saves resumable sessions, plans, checkpoints, and metadata-only task traces.
- Supports Gemini, Groq, and Mistral coding models, with manual or optional Jev-powered routing.
- Includes deterministic and live evaluations for measuring the agent loop over time.

## Jev and automatic routing

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is Kairo’s optional decision and safety layer. It is **not** a coding model and does not generate source code. Gemini, Groq, or Mistral still perform the actual repository work.

Open `/jev` in the TUI to add a TypeSafe API key and control four independent features:

- **Task routing** distinguishes conversation, direct answers, repository work, and requests that should become a read-only plan.
- **Safety context** assesses proposed operations while Kairo’s local approval and workspace rules remain authoritative.
- **Recovery advice** helps choose whether a failed check needs a focused repair, broader context, or escalation.
- **Safe autonomy** may skip a prompt only for a high-confidence, low-risk verification command that Kairo already discovered from the repository. It never grants autonomous file writes or arbitrary shell access.

`/auto` separately toggles automatic model selection. When enabled, Jev classifies each BUILD request as `fast`, `balanced`, or `strong`, then Kairo chooses from models whose credentials are available locally. Decisions below the `0.85` confidence threshold, unavailable tiers, or Jev errors fall back to your manually selected model. Quota failures can fall through to another available model.

Auto routing is opt-in. `/models` always puts you back in manual mode, and an explicit PLAN request is never silently upgraded into implementation. The footer only shows `AUTO` or `JEV` when those features are enabled.

## Repository awareness

Kairo starts with a deterministic, language-neutral snapshot instead of assuming every project is JavaScript or TypeScript. In a Git repository it inventories tracked and untracked, non-ignored files with `git ls-files`. Outside Git it uses a bounded recursive walk. Symlinked directories, dependencies, generated output, binary content, and workspace escapes are excluded from content inspection.

The snapshot records derived metadata for up to 20,000 files:

- file paths, size, modification time, and role such as source, test, manifest, CI, build, documentation, configuration, or agent instruction;
- detected ecosystems from manifests for Node, Python, Go, Rust, JVM, Ruby, PHP, Elixir, and .NET repositories;
- Git root, branch, HEAD, and changed paths when available;
- common source/test roots and existing JavaScript/TypeScript symbols, imports, and test relationships;
- Node verification commands discovered from `package.json`, with the manifest and package-manager lockfile recorded as evidence.

Kairo recognizes root and nested `AGENTS.md` and `CLAUDE.md` files, `.github/copilot-instructions.md`, and `.cursor/rules/**`. Applicable instruction text is read only for the current model request: root rules are always considered, while nested rules are included only for selected files under their directory. Each file is capped at 16 KiB and the complete instruction budget is 32 KiB.

Snapshots are versioned and fingerprinted. Kairo checks freshness when a session starts or resumes and before each model turn after tool activity. Branch, HEAD, working-tree, inventory, or high-signal control-file changes rebuild stale metadata automatically. Old repository profiles are treated as stale and rebuilt once.

Only derived metadata is persisted in SQLite. Source text, instruction contents, README contents, diffs, and command output are not stored in the snapshot. Manifests, CI files, build files, and documentation are surfaced as paths so the agent can inspect the relevant evidence on demand.

## Quick start

You’ll need Node.js 24.21+, pnpm, and an API key for Gemini, Groq, or Mistral.

```bash
pnpm install
pnpm build
node dist/interface/cli/index.js .
```

After installing the package, start Kairo in any repository with:

```bash
kairo [workspace]
```

The first-run flow can validate and store provider credentials in the macOS Keychain. Environment variables also work for one-off use:

```bash
GEMINI_API_KEY=your_key_here kairo .
GROQ_API_KEY=your_key_here kairo .
MISTRAL_API_KEY=your_key_here kairo .
```

## TUI workflow

Type a request normally, or type `/` to open the command palette. Arrow keys move through matches; Tab completes commands that need arguments and runs commands that do not.

- `/plan` toggles read-only planning. `/build` implements the latest saved plan.
- `/models` chooses a coding model and disables Auto. `/auto` toggles Jev-powered automatic routing.
- `/jev` manages the Jev credential, routing, safety, recovery, and autonomy features.
- `/new`, `/resume [session-id]`, and `/history` manage saved sessions.
- `/status`, `/trace [task-id]`, and `/changes` explain what happened.
- `/verify <command>` runs an explicit check through the approval gate; `/compact` saves a context checkpoint.
- `/cancel`, `/logout`, `/help`, and `/quit` handle the remaining session controls.

Press `y` or Enter to approve an action; press `n` or Escape to deny it. Use `Ctrl+O` to expand or collapse the task activity timeline.

Every successful edit invalidates older verification. A task that changed files is not complete until its latest eligible check passes.

## CLI essentials

```bash
# Credentials
kairo auth login [gemini|groq|mistral]
kairo auth logout [gemini|groq|mistral]
kairo auth status

# Saved sessions
kairo sessions list
kairo resume <session-id>

# Agent-loop evaluations
kairo eval
kairo eval jev
kairo eval live
kairo eval self --trials 3
kairo eval history
kairo eval show <run-id>
kairo eval baseline set <run-id>
kairo eval baseline show
kairo eval compare <run-id>
```

`kairo eval` checks deterministic plumbing. `eval jev` uses a local stub to exercise Jev integration; it is not a live latency or quality benchmark. `eval self` is the real-provider capability suite: it creates isolated Kairo snapshots, seeds defects, requires a verified result, and runs independent hidden graders.

Evaluation history and task traces are sanitized. They store IDs, operation names, timing, outcomes, counters, and verification metadata—not prompts, model responses, source contents, credentials, or raw command output.

## Development

```bash
pnpm check
pnpm test
```

The code is split into `domain`, `application`, `infrastructure`, and `interface/cli`. The core loop is bounded, workspace-confined, approval-gated, and designed so a successful command is evidence—not automatic proof that the task is correct.

## Direction

1. Keep the single-agent loop dependable: safer tools, better repair, stronger verification, and useful traces.
2. Add evidence-backed Python, Go, Rust, JVM, and other verification adapters without guessing commands from prose.
3. Add a lightweight repository graph, then Tree-sitter enrichment and on-demand LSP queries where deterministic retrieval needs stronger semantics.
4. Expand realistic broken-repository evaluations and measure reliability, cost, and latency before considering embeddings or a graph database.
5. Add local providers and better evidence-based routing without weakening manual control.
