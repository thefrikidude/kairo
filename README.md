# Kairo
https://github.com/user-attachments/assets/18fd9938-8c6c-45c5-93f0-7073f68743df

Kairo is a small, terminal-first coding agent written in TypeScript. It uses Gemini through a provider boundary, works only inside the workspace you choose, and asks before every file change or shell command.

## Quick start

```bash
pnpm install
pnpm build
pnpm exec kairo auth login
pnpm exec kairo .
```

`GEMINI_API_KEY` overrides the macOS Keychain credential, which is useful in CI. Keys are never written to Kairo's configuration or session database.

Use `/help` inside the REPL to see commands. Sessions are stored locally in the platform state directory and can be resumed with `kairo resume <id>`.

There is still no PTY reattachment after a daemon crash, database inspection command, or support
for agent adapters beyond shell and Codex.

## Prerequisites

Install a current stable Rust toolchain with [rustup](https://rustup.rs/).

## Run locally

Build both binaries once, then launch the workspace:

```bash
cargo build --workspace
target/debug/kairo
```

Kairo starts its daemon automatically, opens one shell terminal in the current directory, and
keeps running terminals alive when you quit the TUI. Click `+ Terminal` to add right-side panes,
then type normal terminal commands such as `codex`, `claude`, `gemini`, `git`, or `npm`. Click a
pane to focus it. Press `Ctrl-]` to return to Kairo's shortcuts: `t` adds a terminal, `h` hides the
selected pane without stopping it, and `d` opens a confirmation before permanently deleting the
selected session and its saved history. Use the Up/Down arrows to select a sidebar session, then
press Enter to open it. Press `r` to rename the selected session. New sessions use the first
submitted command only: common agent CLIs such as `codex`, `claude`, and `gemini` become the title;
other commands use the workspace folder name. The sidebar also restores hidden panes when clicked.

The daemon and agent commands remain available for development and debugging:

```bash
target/debug/kairo daemon status
target/debug/kairo agent list
target/debug/kairo daemon stop
```

The runtime socket and SQLite database default to `$XDG_RUNTIME_DIR/kairo` when available,
otherwise `$HOME/.kairo`. Set `KAIRO_HOME` to an absolute path to isolate Kairo state, which is
useful for development and tests.

```bash
KAIRO_HOME=/tmp/kairo-dev target/debug/kairo daemon start
```

## Attach to an agent

`kairo agent attach <name>` opens a live terminal view of one running agent. Kairo shows the
retained transcript, then streams new PTY output. Input is forwarded to the native agent UI, so
Codex handles prompt editing, Enter submission, shortcuts, and approval prompts itself. Press
`Ctrl-]` to detach while leaving the agent running. One agent can be attached from one terminal at
a time, but other agents and normal Kairo commands continue to work.

## TUI overview

`kairo` is a terminal multiplexer. Its sidebar lists running terminal panes, while the main area
tiles every visible pane left-to-right at equal width. Kairo resizes each PTY whenever a pane is
added, hidden, restored, or when the outer terminal window changes size. Mouse input inside a
terminal application is not supported yet; clicks are used to focus, hide, and restore panes.

## Codex agents

In any Kairo pane, type `codex` and press Enter. Kairo launches the locally installed Codex CLI
with its normal terminal interface and preserves your existing Codex login, approval, sandbox, and
model configuration. Kairo does not add unsafe Codex flags or provide a model account on its own.

## Development checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
