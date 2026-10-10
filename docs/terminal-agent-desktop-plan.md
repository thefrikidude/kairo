# Terminal agent desktop implementation

The user approved this replacement direction on 10 October 2026. All new agent interaction must happen through an interactive CLI in Kairo’s embedded terminal. Keep the desktop shell, project/worktree management, session navigation, file browser and Git review. Remove the built-in model providers and native chat/protocol runtimes. The user explicitly requested deleting legacy chat sessions and transcripts, with no legacy history view. No automatic delegation in Kairo.

## Authoritative reference

Local Orca checkout: `/Users/itsmanan/Computer-Science/Open_Source/orca`. Its current `TuiAgent` catalog contains **45** entries. Catalog names, command aliases, homepage links and exact native resume arguments were adapted with MIT attribution in `THIRD_PARTY_NOTICES.md`. Claude Agent Teams uses Claude’s native interactive mode rather than Orca’s pane/orchestration wrapper. Kairo does not initiate delegation. CLI trust and approvals retain the CLI’s settings and terminal prompts; launch defaults do not bypass them.

## Delivered foundations

- `ba107e3`: complete catalog and install discovery, including aliases and required commands. Finder launch detection hydrates the login-shell PATH and includes bounded common install directories. Availability is checked again before launch. Missing agents remain catalog entries with installation links, never automatically installed. Exact native resume arguments reject unsafe IDs and preserve file-based locators for Pi-family agents.
- `9355a83`: durable terminal-session metadata, independent of workspace records and live PTY handles. The terminal store migration removes known legacy chat/task/evaluation tables once and preserves `task_workspaces`. Opening the new store in tests does not touch the user’s application database. Agent PTYs launch an executable and argv directly, deduplicate concurrent requests for the same session and retain the existing output bounds and process cleanup.
- New terminal desktop backend and API contract: project opening without invented chat sessions; agent session creation/start/stop/open/rename/archive/delete; workspace associations and active selection; concurrency guards per canonical checkout; separate worktree execution; file editing and review; safe worktree removal; bounded startup workspace reconciliation; shutdown drains pending requests and PTYs. This backend is not wired to the production app until the replacement renderer and IPC are ready.

Evidence: typecheck and nine focused tests pass. Tests cover missing/installed aliases, required commands, non-file executable rejection, fresh availability checks, unsafe resume IDs, legacy-table removal, migration repeatability, durable IDs and workspace ownership, direct literal argv, real native PTY I/O and cleanup, concurrent worktrees, navigation retaining both PTYs, actual changed-file review, conservative worktree removal and passing an exact persisted native ID on restart. Fixture processes are stopped before teardown.

A live read-only install scan detected Codex, OpenCode, Pi, Antigravity and Kimi on this Mac. This is installation evidence, not end-to-end verification of these CLIs or their authentication.

## Required remaining work

1. Replace the chat renderer and preload/main/backend protocol with the terminal desktop contract. Preserve desktop layout, themes, resizing and keyboard behavior. Agent sessions occupy the main area; optional utility terminals must remain distinguishable from agent sessions. The picker refreshes discovery when opened, provides search and installation guidance, and launches only installed agents.
2. Capture authoritative native session identity or expose the agent’s native resume picker where no exact identity is available. Persist native metadata for supported agents and use their resume commands on restart. Never guess via a global last session. Clearly show fresh-start behavior for agents without resume support. Current backend accepts exact saved IDs but automatic identity capture is still incomplete.
3. Refresh Git review independently of the removed structured agent tool events. Bound refresh work and retain lazy selected-patch loading, full-file editing and stale-save protection.
4. Remove built-in provider/model code, provider dependencies, old adapters, old chat/task IPC and renderer controls, and obsolete tests/scripts/docs. Activate the one-time legacy-data reset only when the replacement app is usable.
5. Update smoke and performance fixtures for terminal sessions. Verify installed agent interaction inside actual Electron, switching live isolated sessions, review, stop/process cleanup and restart/native resume. Audit each requirement before marking the goal complete.

The app still uses the old chat implementation at this foundation checkpoint. The terminal-only conversion is **not complete**.
