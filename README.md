# Kairo

Kairo is an extensible, terminal-first coding-agent runtime. Its goal is to become an OpenCode-style local workspace: reliable tool use, persistent tasks, pluggable models, model routing, and eventually specialized subagents working under one coordinator.

The project starts with the part that matters most: one agent that can understand a repository, make a safe change, recover from failures, and verify its work.

## Architecture

Kairo follows a dependency-inverted, SOLID-oriented layout:

```text
src/
├── domain/          # Task, message, tool models and dependency ports
├── application/     # Coding-agent and context-management use cases
├── infrastructure/  # SQLite, model providers, filesystem tools, Keychain, configuration
└── interface/cli/   # Terminal command parsing and interactive REPL
```

The application layer depends only on `domain/` interfaces. Gemini and Groq providers, SQLite, and terminal tools are adapters, so they can be replaced without rewriting the coding-agent workflow.

## Current capabilities

- Persisted task traces: use `/trace [task-id]` for chronological events and `/status` for model/tool timing, approval counts, repairs, and command outcomes. Traces contain operation metadata, not prompts, file contents, or raw command output.

- Interactive Ink terminal UI for one local workspace, with a streaming transcript, task status, approval overlays, and an in-session model picker.
- A bounded JavaScript/TypeScript repository profile on session start: package manager, scripts, config files, source/test roots, ignored paths, and a compact file index.
- Task-aware file ranking and line-range reads, so the selected model receives likely relevant files without flooding its context. Ranking combines task/error terms, declared symbols, local imports, and test-to-source relationships.
- Workspace-confined file listing, code search, file reading, exact text edits, file writes, and shell commands.
- Explicit approval before every edit, write, or shell command.
- Bounded model/tool loops, repeated-call protection, failure tracking, and explicit verification status after edits.
- Automatic context checkpoints for long sessions, local SQLite task history, interrupted-task recovery, and session resume. Repository profiles are persisted with sessions, so resuming does not rediscover from zero.
- Discovered test, typecheck, lint, and build scripts are included in the task context. After edits, Kairo recommends the narrowest plausible check, explains its focused/broad scope, and runs it only through the normal approval prompt. A successful approved command records its command, exit status, selection reason, and verification result.
- Failed post-edit verification creates a bounded repair brief from stack traces and test failures, including affected files, excerpts, and remaining retry budget. The selected model can continue repairing in the same task; retries rerun the focused failed check before Kairo proposes a broader discovered check, and every edit and command still requires approval.
- Optional TypeSafe Jev decision layer: confidence-gated, per-request BUILD-to-PLAN routing; advisory risk context in every write/command approval; bounded repair, broader-check, or escalation guidance; and opt-in autonomy for high-confidence, low-risk, repository-discovered verification only. All workspace restrictions remain deterministic; edits and arbitrary commands always require approval.
- Provider-scoped credentials from the macOS Keychain, with `GEMINI_API_KEY`, `GROQ_API_KEY`, and `OPENROUTER_API_KEY` as temporary or CI overrides.

Kairo does not currently implement model failover, a full-screen terminal UI, MCP/plugins, Git worktrees, or subagents. Those are deliberate next phases, not current features.

## Requirements

- Node.js 20 or newer
- pnpm
- A Gemini or Groq API key
- macOS for `kairo auth login`; on other systems, use the provider environment variable instead

## Development

```bash
pnpm install
pnpm build
node dist/interface/cli/index.js .
```

Kairo opens directly into the terminal UI with the last saved model selected. Use `/models` to open the model picker, then use the arrow keys and Enter (or a number key) to select an available model. Selecting a model pins manual mode and Kairo will not override it. With Jev enabled, `/auto` toggles per-BUILD-task model routing across only the locally credentialed models in Kairo's allowlist; entering `/auto` again returns to the pinned fallback. PLAN mode is always user-controlled and never auto-switches models. Selecting a provider without a credential opens a masked in-TUI API-key prompt; Kairo validates the key and saves it in macOS Keychain. OpenRouter starts with curated free, tool-capable models; use `/model openrouter <model-id>` for any compatible OpenRouter model. Free availability and rate limits are controlled by OpenRouter and may change. TypeSafe Jev is intentionally excluded from active model selection because it produces typed decisions rather than code or chat responses.

Use `/jev` to configure TypeSafe Jev as an optional decision layer. Its panel has a master toggle plus routing, safety, recovery, and safe-autonomy toggles. For a BUILD request, a `plan` route at 85% confidence or above creates a read-only plan for that request only; the session remains in BUILD mode. With safe autonomy enabled, Jev may run only a repository-discovered verification command when its risk assessment is high-confidence and low risk. Reads already run without approval; file edits, writes, and every arbitrary or manually supplied shell command still require the user. After failed verification, Jev can recommend a bounded repair, a broader discovered check, or a manual escalation. Explicit PLAN mode always wins. Jev never generates code, bypasses workspace restrictions, blocks a user-approved action, or grants wider permissions after a fallback. Its key is stored separately in macOS Keychain (or supplied with `TYPESAFE_API_KEY`). Kairo sends only bounded metadata: task/action labels, repository-relative paths, command text, check scope, and sanitized failure locations. It never sends source contents, edit payloads, tool output, credentials, or raw provider responses; traces retain only decision type, result/confidence bucket, fallback, and duration.

## Production

After installing Kairo, start it with its package executable:

```bash
kairo [workspace]
```

Use `node dist/interface/cli/index.js .` only for local development of this repository.

To avoid saving a key to the Keychain, provide it only for the current command:

```bash
GEMINI_API_KEY=your_key_here node dist/interface/cli/index.js .
```

Kairo never stores API keys in its config file, session database, or Git repository.

## Commands

```bash
# Development: start a new workspace session from this checkout
node dist/interface/cli/index.js [workspace]

# Production: start a new workspace session through the installed package
kairo [workspace]

# Credentials
node dist/interface/cli/index.js auth login
node dist/interface/cli/index.js auth login groq
node dist/interface/cli/index.js auth logout
node dist/interface/cli/index.js auth logout groq
node dist/interface/cli/index.js auth status

# Model configuration
node dist/interface/cli/index.js config get model
node dist/interface/cli/index.js config get provider
node dist/interface/cli/index.js config set model <model-name>

# Session history
node dist/interface/cli/index.js sessions list
node dist/interface/cli/index.js resume <session-id>

# Run the isolated scripted benchmark suite
node dist/interface/cli/index.js eval
node dist/interface/cli/index.js eval --json

# Run live Gemini tasks in disposable fixtures and score their traces with DeepEval
node dist/interface/cli/index.js eval live
node dist/interface/cli/index.js eval live --json

# Run real tasks with the selected provider against isolated, Git-free Kairo source snapshots
node dist/interface/cli/index.js eval self
node dist/interface/cli/index.js eval self --trials 3 --json
node dist/interface/cli/index.js eval history
node dist/interface/cli/index.js eval show <run-id>

# Select a local completed baseline with at least three trials
node dist/interface/cli/index.js eval baseline set <run-id>
node dist/interface/cli/index.js eval baseline show
node dist/interface/cli/index.js eval compare <run-id>
```

Inside a session, type `/` to open the command palette; keep typing to filter commands, then use the arrow keys and Enter or Tab to run a no-argument command or fill a command that needs more input. `/plan` silently toggles the live interaction mode. In PLAN mode, repository requests create a read-only, structured implementation plan; it cannot edit files or run commands. Enter `/plan` again to return to BUILD mode, where ordinary messages use the normal coding-agent loop. The mode is intentionally reset to BUILD when Kairo starts, a new session is created, or another session is resumed. The bordered composer shows the active PLAN or BUILD mode and selected model beneath the input. The Ink UI displays streamed responses, task state, and approval prompts; press `y` or Enter to allow an action, or `n` or Escape to deny it.

## Safety model

Kairo resolves tool paths against the selected workspace and rejects attempts to escape it, including through symlinks. Read-only tools run immediately. Mutating actions always show the requested action and require a `y` or `yes` confirmation.

Tool calls, approvals, outputs, and conversation messages are persisted so an interrupted session can be resumed. Session data is stored under the platform state directory; set `KAIRO_STATE_DIR` to use an isolated location for development or tests.

## Roadmap

1. **Make one agent dependable** — in progress: bounded tool loops, failure recovery, deterministic context checkpoints, repository profiling and relevance ranking, interrupted-task recovery, approval-gated focused verification, and bounded repair are implemented. Next is measuring and improving repair reliability across more realistic tasks.
2. **Add provider abstraction** — implemented for Gemini and Groq through a shared provider registry; local providers remain future work.
3. **Route tasks to models** — Jev can route the current request between BUILD and a read-only plan; selecting fast, cheap, or stronger coding models based on measured reliability remains future work.
4. **Add specialized subagents** — research, coding, and testing child sessions coordinated by a main agent.
5. **Build an evaluation system** — run repeatable coding tasks and compare models, routing rules, agent profiles, cost, latency, and verified success.

## Development

Kairo retries temporary rate limits, network failures, and service errors at most three times per model turn, with a total retry-wait budget of 30 seconds. Provider retry delays take precedence over exponential backoff. Authentication, invalid requests, explicitly exhausted daily quotas, and streams that have already delivered content are not replayed. The wait budget does not limit total generation time. Retry progress goes to stderr during self evaluations so JSON stdout remains valid.

Self evaluations preserve task metrics when a provider fails, and save sanitized failure categories plus retry counts and wait time. Comparisons retain the all-attempt pass rate and additionally show infrastructure failures and the coding-outcome pass rate excluding them. Older retry metrics remain unavailable; historical failures incorrectly classified as verification cannot be reconstructed from saved metadata.

Self-evaluation baselines are selected manually and stored locally as a pointer to an existing completed run with at least three trials. Later self runs automatically report aggregate and per-scenario changes against the selected baseline. Reports compare observed pass rates, passed-attempt counts, and average model turns, tool executions, repairs, verification failures, and duration. Missing observations show N/A; unequal trial counts retain their actual denominators. Model mismatches show both summaries without deltas. Comparisons are informational: self-evaluation exit codes still depend only on the current run's result, and a successful `eval compare` command exits zero even for regressions. Baseline and compare commands also accept `--json`; self JSON adds a `comparison` field when a baseline exists.

Trace durations separate model streaming, tool execution, and approval waiting; they are measured operation time, not total task wall time. Unfinished operations remain visible after interruption. Older tasks have no historical trace backfill. Only discovered checks, explicit model checks (`run_command` with `verification: true`), and manual `/verify` commands count as verification. Every successful file-tool edit invalidates prior verification. Project-wide scripts report broad scope even when chosen for a particular source file. Repair convergence requires a completed task whose latest check passed. A passing command is not proof of task correctness. Token usage and cost are not measured yet.

`kairo eval` runs deterministic scripted model decisions against disposable fixture copies. It measures the agent loop, tool safety, repair flow, verification, and tracing without calling any model provider. It is the reproducible baseline for later live-provider evaluations; it does not measure model reasoning quality.

`kairo eval jev` runs the same deterministic fixtures twice, with the Jev layer off and with fixed high-confidence decision fixtures on. It reports verified completion, repairs, failed checks, escalations, routing/safety/recovery counts, and Jev latency. It does not call TypeSafe or judge live Jev quality; use it to spot integration regressions and decision-layer overhead.

`kairo eval live` runs the same tasks with Gemini in disposable fixture copies and asks DeepEval's `TaskCompletionMetric` to judge each recorded agent trajectory. It requires a Gemini credential, consumes Gemini API usage for both the agent and judge, and is intentionally separate from the deterministic test gate. The final result requires both the fixture's independent filesystem/test assertion and the DeepEval verdict to pass. DeepEval receives only the task, final response, tool names, status, and verification metadata; it does not receive source files or command output.

`kairo eval self` is the first capability suite: it copies the current Kairo repository into a fresh temporary directory without `.git` or build artifacts, installs locked dependencies offline, seeds realistic defects, and gives the selected provider the normal coding-agent tools. Kairo passes only when its own task reaches a completed, verified state and hidden graders confirm the fix plus the full test suite. Use `--trials 1` through `--trials 5` to measure repeated-run reliability. Each run saves a local SQLite record containing only provider/model/revision identifiers, counters, timing, pass state, and a sanitized failure category—never prompts, model responses, source, or command output. Use `kairo eval history` and `kairo eval show <run-id>` to compare runs. It consumes the selected provider's API usage and must be run from the Kairo repository root.

```bash
pnpm check
pnpm test
```

The tests cover repository profiling, script discovery, ignored/generated-file filtering, task-aware file ranking, persisted profiles, session recovery, approval behavior, workspace boundaries, symlink escapes, and verification exit status.
