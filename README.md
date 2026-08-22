# Kairo

Kairo is a terminal-native runtime for managing persistent AI coding agents. It does not
implement an AI agent itself; future versions will run existing agent CLIs inside managed
terminal sessions.

## Current milestone

This first milestone establishes the process boundary:

- `kairo-daemon` is a background process that owns the local runtime socket.
- `kairo` is a short-lived terminal client that sends commands to the daemon.
- `kairo-core` holds the shared protocol, runtime-path logic, and errors.

There is deliberately no PTY management, database, agent model, or TUI yet.

## Prerequisites

Install a current stable Rust toolchain with [rustup](https://rustup.rs/).

## Run locally

Build both binaries once, then use the CLI:

```bash
cargo build --workspace
target/debug/kairo daemon start
target/debug/kairo daemon status
target/debug/kairo daemon stop
```

The runtime socket defaults to `$XDG_RUNTIME_DIR/kairo` when available, otherwise
`$HOME/.kairo`. Set `KAIRO_HOME` to an absolute path to isolate Kairo state, which is useful
for development and tests.

```bash
KAIRO_HOME=/tmp/kairo-dev target/debug/kairo daemon start
```

## Development checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
