# Kairo

Kairo is a terminal-native runtime for managing persistent AI coding agents. It does not
implement an AI agent itself; future versions will run existing agent CLIs inside managed
terminal sessions.

## Current milestone

This first milestone establishes the process boundary:

- `kairo-daemon` is a background process that owns the local runtime socket.
- `kairo` is a short-lived terminal client that sends commands to the daemon.
- `kairo-core` holds the shared protocol, runtime-path logic, and errors.

The daemon supervises one PTY-backed shell command per agent and preserves each agent's most
recent 64 KiB of terminal history in a local SQLite database. The CLI can exit (or its terminal
can close) without stopping the detached daemon or its agents. If the daemon itself crashes,
Kairo restores saved agents and logs on the next start; agents that were active become
`interrupted` because their final result is unknown.

There is still no PTY reattachment after a daemon crash, database inspection command, or support
for agent adapters beyond shell and Codex.

## Prerequisites

Install a current stable Rust toolchain with [rustup](https://rustup.rs/).

## Run locally

Build both binaries once, then use the CLI:

```bash
cargo build --workspace
target/debug/kairo daemon start
target/debug/kairo daemon status
target/debug/kairo tui
target/debug/kairo agent create coder --workspace "$(pwd)"
target/debug/kairo agent start coder -- sh -c 'sleep 30'
target/debug/kairo agent create codex-worker --adapter codex --workspace "$(pwd)"
target/debug/kairo agent start codex-worker
target/debug/kairo agent list
target/debug/kairo agent logs coder
target/debug/kairo agent send coder -- "echo hello"
target/debug/kairo agent attach coder
target/debug/kairo agent interrupt coder
target/debug/kairo agent stop coder
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

`kairo tui` opens Kairo's terminal dashboard. It shows one tab per registered agent and the
selected agent's retained log, refreshing from the daemon every 300 milliseconds. In dashboard
mode, use `Left`/`Right` (or `h`/`l`) to switch tabs, `r` to refresh immediately, and `q` to exit.
Press `Enter` on a running agent to open its live terminal in that tab. Kairo renders the native
terminal screen, forwards your keys to the agent, and resizes the PTY when the Kairo window size
changes. Press `Ctrl-]` to return to Kairo controls while leaving the agent running.

## Codex agents

Create a Codex session with `--adapter codex`, then start it without supplying a shell command.
Kairo launches the locally installed `codex` CLI with its normal terminal interface and preserves
your existing Codex login, approval, sandbox, and model configuration. Kairo does not add unsafe
Codex flags or provide a model account on its own.

## Development checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
