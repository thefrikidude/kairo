# Kairo

Kairo is a local desktop workspace for coding agents. Choose an installed agent such as Codex, Claude, OpenCode or Pi and use its interactive terminal inside the app. Kairo manages projects, isolated Git worktrees, terminal sessions, files and code review. Models, authentication, prompts and approvals belong to the selected agent CLI.

## Run from source

Requirements: macOS, Git, Node.js 24.21+, pnpm, and an installed interactive agent CLI.

```sh
pnpm install
pnpm desktop:dev
```

For a built preview:

```sh
pnpm desktop:build
pnpm desktop:preview
```

Installers, signing and release distribution are not configured.

## Start a session

1. **Open project** selects a local folder.
2. **New agent session** opens the CLI picker. Kairo detects the 45 agent choices in the referenced Orca catalog, including command aliases and required binaries. Use **Refresh agents** after installation; unavailable agents offer their installation guide. Kairo does not install agents.
3. Choose the project folder, a new isolated worktree, or an existing worktree. Git projects default to a new isolated worktree. It starts from committed files; uncommitted edits and dependencies are not copied.
4. **Open agent terminal** opens your normal interactive shell in the chosen directory and runs the agent as a foreground command. Use its own login, model, approval and conversation controls. Exit the agent to return to the shell prompt. Ctrl+Z suspends the agent so you can run ordinary commands in the same terminal; run `fg` to return to the agent.

The sidebar groups sessions by project and shows worktree branches. Rename and pin sessions there. Switching sessions keeps their terminals running and preserves their live terminal screens. A green dot means the terminal process is open; Kairo does not infer that the agent is working from terminal output.

**Settings → Workspaces → Close terminal** closes the shell, its CLI and attached child processes. Exiting the CLI alone keeps the shell open. Stop a session before archiving or deleting it. Session names, workspace associations and exact native resume targets persist in SQLite; PTY processes stop when Kairo quits. Codex and OpenCode conversation identities are captured automatically from their local metadata stores and matched to the launched workspace. Reopening uses the saved conversation; no global “last session” is guessed.

**Files**, in the right sidebar, provides a lazy tree, filename search, text preview and small-file editing. Saves check the loaded revision and refuse overwriting external changes. Unsaved buffers survive workspace navigation, and quitting asks you to save or discard them. Binary files and files over 1 MB are refused rather than truncated.

**Review**, in the right sidebar, lists changed paths and loads only the selected diff, with unified and split views. Changes since the workspace's starting commit include commits the agent made; working-tree scope includes staged, unstaged and untracked files. The visible panel refreshes periodically independently of the CLI's output. File lists and diff rows are virtualized.

**+ Terminal**, in the tab bar, opens an additional shell in the current workspace. **+ Agent** opens the agent picker. Shell and agent tabs share the center pane. These additional terminals survive navigation; each agent session already has its own normal shell. Tabs preserve input, ANSI output and live screens when switching. Close terminals from Settings → Workspaces. **Settings → Workspaces** lists open terminals and managed worktrees.

Worktree removal requires archiving associated sessions and closing terminals. Git refuses removal with staged, unstaged, untracked or ignored files, or unmerged commits. Branches remain available. Deleting a Kairo session never deletes its workspace or the CLI's own history. Worktrees separate files; the selected CLI owns its execution safeguards.

Keyboard shortcuts: Cmd/Ctrl+Shift+N opens a new session; Cmd/Ctrl+Shift+E opens Files; Cmd/Ctrl+Shift+D opens Review; Cmd/Ctrl+Shift+B toggles the sidebar; Cmd/Ctrl+` opens a new terminal tab. Escape inside a terminal is delivered to the CLI. Dialogs contain focus while open and return focus on close.

## Data migration

This version replaces Kairo's built-in model engine and protocol-based chats. On first opening the terminal desktop database, it removes Kairo's legacy chat, task and evaluation data, as requested for this product pivot. Existing workspace/worktree records remain. Vendor-owned CLI conversations and credentials are unaffected.

## Development

```sh
pnpm check
pnpm test
pnpm desktop:build
node scripts/desktop-smoke.mjs
```

The desktop smoke uses a fixture CLI in temporary Git workspaces. It exercises actual terminal keyboard input, the agent picker, isolated session creation, live switching, file/diff review, editing and exact saved native-ID resume after restart. It removes temporary state and verifies owned terminals stopped. Set `KAIRO_SMOKE_OUTPUT` to retain screenshots and metrics.

`node scripts/desktop-benchmark.mjs` measures fresh launches and painted session switching with 24 workspace/session records and fixture CLI terminals. `KAIRO_BENCH_RUNS` controls sample count; `KAIRO_BENCH_OUTPUT` retains reports. Resident-memory totals include Electron, the Node backend and child processes; shared pages may be counted repeatedly. Compare only compatible terminal-desktop revisions.

The implementation and remaining native-session verification are tracked in [the terminal desktop checkpoint](docs/terminal-agent-desktop-plan.md). Orca-derived catalog metadata is attributed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Kairo does not automatically delegate tasks to agents.

Shell prompts show the full current working directory and update after `cd`. New managed worktree paths end in the project folder name, inside a readable task directory. Existing worktrees retain their original locations.
