# Kairo

Kairo is an extensible, terminal-first coding-agent runtime. Its goal is to become an OpenCode-style local workspace: reliable tool use, persistent tasks, pluggable models, model routing, and eventually specialized subagents working under one coordinator.

The project starts with the part that matters most: one agent that can understand a repository, make a safe change, recover from failures, and verify its work.

## Architecture

Kairo follows a dependency-inverted, SOLID-oriented layout:

```text
src/
├── domain/          # Task, message, tool models and dependency ports
├── application/     # Coding-agent and context-management use cases
├── infrastructure/  # SQLite, Gemini, filesystem tools, Keychain, configuration
└── interface/cli/   # Terminal command parsing and interactive REPL
```

The application layer depends only on `domain/` interfaces. Gemini, SQLite, and terminal tools are adapters, so they can be replaced without rewriting the coding-agent workflow.

## Current capabilities

- Interactive Gemini coding-agent REPL for one local workspace.
- Workspace-confined file listing, code search, file reading, exact text edits, file writes, and shell commands.
- Explicit approval before every edit, write, or shell command.
- Bounded model/tool loops, repeated-call protection, failure tracking, and explicit verification status after edits.
- Automatic context checkpoints for long sessions, local SQLite task history, interrupted-task recovery, and session resume.
- Gemini credentials from the macOS Keychain, with `GEMINI_API_KEY` as a temporary or CI override.

Kairo does not currently implement model routing, a full-screen terminal UI, MCP/plugins, Git worktrees, or subagents. Those are deliberate next phases, not current features.

## Requirements

- Node.js 20 or newer
- pnpm
- A Gemini API key for the current provider implementation
- macOS for `kairo auth login`; on other systems, set `GEMINI_API_KEY` instead

## Quick start

```bash
pnpm install
pnpm build
node dist/interface/cli/index.js auth login
node dist/interface/cli/index.js .
```

To avoid saving a key to the Keychain, provide it only for the current command:

```bash
GEMINI_API_KEY=your_key_here node dist/interface/cli/index.js .
```

Kairo never stores API keys in its config file, session database, or Git repository.

## Commands

```bash
# Start a new workspace session
node dist/interface/cli/index.js [workspace]

# Credentials
node dist/interface/cli/index.js auth login
node dist/interface/cli/index.js auth logout
node dist/interface/cli/index.js auth status

# Model configuration
node dist/interface/cli/index.js config get model
node dist/interface/cli/index.js config set model <model-name>

# Session history
node dist/interface/cli/index.js sessions list
node dist/interface/cli/index.js resume <session-id>
```

Inside a session, use `/help`, `/new`, `/history`, `/resume` (current task), `/resume <id>` (another session), `/status`, `/changes`, `/verify <command>`, `/compact`, `/cancel`, `/model`, and `/quit`.

## Safety model

Kairo resolves tool paths against the selected workspace and rejects attempts to escape it, including through symlinks. Read-only tools run immediately. Mutating actions always show the requested action and require a `y` or `yes` confirmation.

Tool calls, approvals, outputs, and conversation messages are persisted so an interrupted session can be resumed. Session data is stored under the platform state directory; set `KAIRO_STATE_DIR` to use an isolated location for development or tests.

## Roadmap

1. **Make one agent dependable** — in progress: bounded tool loops, failure recovery, deterministic context checkpoints, task checkpoints, interrupted-task recovery, and post-change verification are implemented. Next is better repository relevance ranking and richer automated repair after failed tests.
2. **Add provider abstraction** — make Gemini only the first `ModelProvider`, then add other cloud and local models without changing the agent loop.
3. **Route tasks to models** — select fast, cheap, or stronger models based on task class, measured cost, latency, and reliability.
4. **Add specialized subagents** — research, coding, and testing child sessions coordinated by a main agent.
5. **Build an evaluation system** — run repeatable coding tasks and compare models, routing rules, agent profiles, cost, latency, and verified success.

## Development

```bash
pnpm check
pnpm test
```

The tests cover session persistence, denied mutating actions, workspace boundaries, symlink escapes, and tool execution behavior.
