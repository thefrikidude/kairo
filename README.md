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
2. Select **New workspace** for a separate task. Git projects default to an isolated worktree; an agent is optional.
3. Inside a workspace, use **+ Terminal** for a plain shell or **+ Agent** to choose an installed agent. Additional tabs share that workspace's files and Git state.
4. Select **Open agent terminal** for a stopped session. Kairo runs the CLI in an interactive shell.

The picker includes 45 agent choices from the referenced Orca catalog and detects installed commands, aliases and required binaries. Missing agents offer installation guides. Install the CLI yourself, then select **Refresh agents**; Kairo does not install it for you.

The sidebar groups named workspaces by project. Agent and plain-terminal tabs in the selected workspace share the center pane. Switching tabs keeps their processes running and preserves terminal screens and scrollback. Exit the agent to return to the same terminal's prompt. Ctrl+Z suspends a foreground agent; `fg` returns to it. The right sidebar contains **Files** and **Review**; there is no separate Shell panel.

## Projects and workspaces

A workspace owns its repository path, directory, branch and Git baseline. An agent session owns its selected CLI and conversation identity. Multiple agent sessions can work independently in separate worktrees. Additional agent tabs can share the selected workspace. Their terminals are independent, but their files and Git state are shared. Choose an isolated worktree for independent changes.

New worktrees start from committed files. Task names derive unique `kairo/<task>-<suffix>` branches, with an optional override. Choose a starting branch or commit from the searchable ref field. Kairo uses the saved project base, a locally known remote default, or the primary checkout's branch/`HEAD`. Missing saved bases require correction in **Project setup**. **Refresh remote refs** explicitly fetches; creation otherwise stays local.

Right-click a project or workspace and choose **Project setup** to save an optional setup script and literal ignored paths to copy. Copies come from the primary checkout and belong independently to the new worktree. Tracked paths, symlinks, escapes, missing files and existing destination files are refused. Copying is bounded to 10,000 files / 256 MB; use scripts for larger preparation. Dependencies remain independently installed rather than symlinked.

Setup runs with `/bin/sh -e` in the new worktree, with `KAIRO_SOURCE_DIR` and `KAIRO_WORKSPACE_DIR` identifying both directories. Output retains its latest 32,000 characters. Scripts have a ten-minute limit and must finish; run development servers in ordinary terminal tabs. Setup scripts currently require macOS or Linux.

Creation continues in the background through checkout, copying and setup. Navigate elsewhere while it runs, or select its progress row to cancel. Failure/cancellation retains created files. **Retry preparation** uses the latest project settings and skips files already copied successfully; an optional agent starts only after preparation succeeds. Restart records interrupted preparation and offers recovery without automatically rerunning scripts.

New managed worktree paths end in the project's folder name, inside a task directory. Existing worktrees keep their locations. Worktrees remain ordinary Git checkouts usable from external tools. Selection, app focus and explicit refresh reconcile branch metadata and label missing directories unavailable without deleting history.

Archive a workspace from its row to close all its terminals and hide it while retaining files, branches, and agent identities. Restore it through **Settings → Archived**; restoration does not launch all its tabs. **Settings → Workspaces** offers separate removal after archiving the workspace or associated sessions and closing terminals. Git refuses removal while staged, unstaged, untracked or ignored files, or unmerged commits remain. Removing a worktree preserves its branch.

## Session management

Right-click a workspace row to rename, pin/unpin, or archive it. Right-click a project heading for New workspace and Project setup. Shift+F10 opens the same menu from a focused row. Workspace pins, names and last selected tabs persist in SQLite. Existing session pins migrate to workspace pins. A green dot means a workspace has an open terminal; it does not indicate whether an agent is currently working.

Right-click an agent tab to rename or archive it; right-click a plain terminal tab to close it. Archiving that session closes its attached terminal and preserves its metadata, workspace and vendor-owned conversation history. Restore it through **Settings → Archived**. Workspace archiving preserves individual session archive flags. Other terminals remain open. **Settings → Workspaces → Close terminal** closes a terminal and its attached processes. Close a session's terminal before deleting that session; deleting session metadata does not delete workspace files or CLI history.

Session metadata persists in SQLite. Terminal processes stop when Kairo quits; the active agent session is reopened on startup. Codex and OpenCode conversation IDs are captured from their local metadata stores, matched to the workspace and launch time. Ambiguous matches are refused instead of choosing a global “last session.” When matching agents share a directory, Kairo preserves previously captured IDs but does not automatically assign new ones; use the CLI’s conversation picker for recovery. Exact recovery requires a saved conversation ID. Automatic identity capture is currently limited to Codex and OpenCode; other agents use their own history/resume controls and may require a new Kairo session after restart.

## Files and review

**Files** provides a lazy directory tree, filename search, text preview and small-file editing. Saves check the loaded revision and refuse to overwrite external changes. Unsaved buffers survive workspace navigation, and quitting asks you to save or discard them. Binary files and files over 1 MB cannot be edited.

**Review** lists changed paths and loads the selected diff in unified or split view. Task scope shows changes since the workspace's starting commit, including agent-created commits. Working-tree scope includes staged, unstaged and untracked changes. The visible panel refreshes independently of terminal output. File lists and diff rows are virtualized.

## Keyboard shortcuts

| Shortcut           | Action                     |
| ------------------ | -------------------------- |
| Cmd/Ctrl+Shift+N   | New workspace              |
| Cmd/Ctrl+J         | Jump to workspace or tab   |
| Cmd/Ctrl+P         | Quick open file            |
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

The desktop smoke uses a fixture CLI in temporary Git workspaces. It checks terminal keyboard input, plain-terminal and agent tabs, project setup, background isolated worktrees, independent ignored-file copies, workspace navigation, keyboard palettes, editing, diffs, mouse pin/unpin, workspace/session archives, restoration and exact conversation recovery after restart. It removes temporary state and checks that owned terminal processes stopped. `KAIRO_SMOKE_OUTPUT` selects the screenshot and metrics directory.

An additional **opt-in, experimental** smoke exercises installed, authenticated Codex and OpenCode:

```sh
node scripts/installed-agent-smoke.mjs
```

It sends small proof tasks to real agents and can consume provider usage. `KAIRO_NATIVE_CODEX_MODEL` and `KAIRO_NATIVE_OPENCODE_MODEL` override the test models without modifying CLI configuration; otherwise the CLIs use their configured models. `KAIRO_NATIVE_OUTPUT` selects the evidence directory. Native CLI trust, model availability and authentication can affect the run; a complete installed-agent workflow/restart pass is still pending verification.

`node scripts/desktop-benchmark.mjs` measures fresh launches and painted session switching with 24 workspace/session records and fixture CLI terminals. `KAIRO_BENCH_RUNS` controls sample count; `KAIRO_BENCH_OUTPUT` selects the report directory. Stage measurements separate Kairo-owned RSS from shells/agents, and include noisy output and three open/close recovery cycles. `KAIRO_BENCH_EMPTY=1` measures idle startup and memory. Shared pages may be counted repeatedly. Compare compatible terminal-desktop revisions only.

Implementation checkpoints and remaining verification are recorded in [the terminal desktop plan](docs/terminal-agent-desktop-plan.md). Orca-derived catalog metadata is attributed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The workspace-first delivery and benchmark methodology are recorded in [the workspace workflow checkpoint](docs/workspace-workflow.md). The current TypeScript/Electron optimizations and measured limits are recorded in [the resource checkpoint](docs/lightweight-electron.md).
