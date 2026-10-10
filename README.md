# Kairo

Kairo is a local desktop app for coding-agent terminals. Run Codex, Claude, OpenCode, Pi or another installed agent in a normal terminal, switch between tabs, and inspect files and Git changes beside your work.

Kairo manages projects, task workspaces and terminal sessions. Each agent CLI owns its models, authentication, conversation and approvals. There is no built-in model engine, API-key settings page or automatic agent delegation.

## Run locally

Requirements: macOS, Git, Node.js 24.21+ and pnpm. Install an agent CLI to create agent sessions; plain terminals do not require one.

```sh
pnpm install
pnpm desktop:dev
```

For a production build and local preview:

```sh
pnpm desktop:build
pnpm desktop:preview
```

Kairo currently runs from source. Installers, signing and release distribution are not configured.

## Terminals and agents

1. Select **Open project** and choose a local folder.
2. Use **+ Terminal** in the tab bar to open a plain terminal in the current workspace, or **+ Agent** / **New agent session** to choose an agent.
3. For an agent session, use the current workspace by default, or explicitly choose a new isolated Git worktree or another existing workspace.
4. Select **Open agent terminal**. Kairo opens an interactive shell and runs the agent as a foreground command.

The picker includes 45 agent choices from the referenced Orca catalog and detects installed commands, aliases and required binaries. Missing agents offer installation guides. Install the CLI yourself, then select **Refresh agents**; Kairo does not install it for you.

Agent and plain-terminal tabs share the center pane. Switching tabs keeps their processes running and preserves terminal screens and scrollback. Exit the agent to return to the same terminal's prompt. Ctrl+Z suspends a foreground agent; `fg` returns to it. The right sidebar contains **Files** and **Review**; there is no separate Shell panel.

## Projects and workspaces

A workspace owns its repository path, directory, branch and Git baseline. An agent session owns its selected CLI and conversation identity. Multiple agent sessions can work independently in separate worktrees. Additional agent tabs can share the selected workspace. Their terminals are independent, but their files and Git state are shared. Choose an isolated worktree for independent changes.

New worktrees start from committed files. Uncommitted edits, dependencies and ignored files are not copied. Install the project's dependencies in the new workspace when needed.

New managed worktree paths end in the project's folder name, inside a task directory. Prompts show the full current directory and follow `cd`. Existing worktrees keep their original locations, so older paths can still contain hashes or UUIDs.

Worktree removal is available in **Settings → Workspaces** after associated sessions are archived and terminals are closed. Git refuses removal while staged, unstaged, untracked or ignored files, or unmerged commits remain. Removing a worktree preserves its branch.

## Session management

The left sidebar groups sessions by project and shows their branches. Rename a session, pin it into the **Pinned** section, or archive it directly from its row. Pins survive app restarts. A green dot means the terminal is open; it does not indicate whether the agent is currently working.

Archiving closes the session's attached terminal and preserves its metadata, workspace and vendor-owned conversation history. Restore it through **Settings → Archived sessions**. Other terminals remain open. **Settings → Workspaces → Close terminal** closes a terminal and its attached processes. Close a session's terminal before deleting that session; deleting session metadata does not delete workspace files or CLI history.

Session metadata persists in SQLite. Terminal processes stop when Kairo quits; the active agent session is reopened on startup. Codex and OpenCode conversation IDs are captured from their local metadata stores, matched to the workspace and launch time. Ambiguous matches are refused instead of choosing a global “last session.” When matching agents share a directory, Kairo preserves previously captured IDs but does not automatically assign new ones; use the CLI’s conversation picker for recovery. Exact recovery requires a saved conversation ID. Automatic identity capture is currently limited to Codex and OpenCode; other agents use their own history/resume controls and may require a new Kairo session after restart.

## Files and review

**Files** provides a lazy directory tree, filename search, text preview and small-file editing. Saves check the loaded revision and refuse to overwrite external changes. Unsaved buffers survive workspace navigation, and quitting asks you to save or discard them. Binary files and files over 1 MB cannot be edited.

**Review** lists changed paths and loads the selected diff in unified or split view. Task scope shows changes since the workspace's starting commit, including agent-created commits. Working-tree scope includes staged, unstaged and untracked changes. The visible panel refreshes independently of terminal output. File lists and diff rows are virtualized.

## Keyboard shortcuts

| Shortcut           | Action                     |
| ------------------ | -------------------------- |
| Cmd/Ctrl+Shift+N   | New agent session          |
| Cmd/Ctrl+backquote | New plain terminal tab     |
| Cmd/Ctrl+Shift+E   | Files                      |
| Cmd/Ctrl+Shift+D   | Review                     |
| Cmd/Ctrl+Shift+B   | Toggle the project sidebar |

Escape inside a terminal is delivered to the CLI. Tab bars support arrow-key navigation. Dialogs contain focus and return it when closed.

## Data migration

This version replaces the former built-in model engine and protocol-based chat UI. The first opening of the terminal desktop database removes Kairo's legacy chat, task and evaluation records. Existing workspace/worktree records remain. Vendor-owned CLI conversations and credentials are unaffected.

## Development and verification

```sh
pnpm check
pnpm test
pnpm desktop:build
node scripts/desktop-smoke.mjs
```

The desktop smoke uses a fixture CLI in temporary Git workspaces. It checks terminal keyboard input, plain-terminal and agent tab creation, isolated worktrees, file editing, diffs, pin/unpin with mouse clicks, archiving a running session, restoration and exact conversation recovery after restart. It removes temporary state and checks that owned terminal processes stopped. `KAIRO_SMOKE_OUTPUT` selects the screenshot and metrics directory.

An additional **opt-in, experimental** smoke exercises installed, authenticated Codex and OpenCode:

```sh
node scripts/installed-agent-smoke.mjs
```

It sends small proof tasks to real agents and can consume provider usage. `KAIRO_NATIVE_CODEX_MODEL` and `KAIRO_NATIVE_OPENCODE_MODEL` override the test models without modifying CLI configuration; otherwise the CLIs use their configured models. `KAIRO_NATIVE_OUTPUT` selects the evidence directory. Native CLI trust, model availability and authentication can affect the run; a complete installed-agent workflow/restart pass is still pending verification.

`node scripts/desktop-benchmark.mjs` measures fresh launches and painted session switching with 24 workspace/session records and fixture CLI terminals. `KAIRO_BENCH_RUNS` controls sample count; `KAIRO_BENCH_OUTPUT` selects the report directory. Memory totals include Electron, the Node backend and child processes, and shared pages may be counted repeatedly. Compare compatible terminal-desktop revisions only.

Implementation checkpoints and remaining verification are recorded in [the terminal desktop plan](docs/terminal-agent-desktop-plan.md). Orca-derived catalog metadata is attributed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
