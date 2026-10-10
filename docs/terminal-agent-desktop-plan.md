# Terminal agent desktop implementation

The user approved this replacement direction on 10 October 2026. All new agent interaction must happen through an interactive CLI in Kairo’s embedded terminal. Keep the desktop shell, project/worktree management, session navigation, file browser and Git review. Remove the built-in model providers and native chat/protocol runtimes. The user explicitly requested deleting legacy chat sessions and transcripts, with no legacy history view. No automatic delegation in Kairo.

## Authoritative reference

Local Orca checkout: `/Users/itsmanan/Computer-Science/Open_Source/orca`. Its current `TuiAgent` catalog contains **45** entries. Catalog names, command aliases, homepage links and exact native resume arguments were adapted with MIT attribution in `THIRD_PARTY_NOTICES.md`. Claude Agent Teams uses Claude’s native interactive mode rather than Orca’s pane/orchestration wrapper. Kairo does not initiate delegation. CLI trust and approvals retain the CLI’s settings and terminal prompts; launch defaults do not bypass them.

## Delivered foundations

- `ba107e3`: complete catalog and install discovery, including aliases and required commands. Finder launch detection hydrates the login-shell PATH and includes bounded common install directories. Availability is checked again before launch. Missing agents remain catalog entries with installation links, never automatically installed. Exact native resume arguments reject unsafe IDs and preserve file-based locators for Pi-family agents.
- `9355a83`: durable terminal-session metadata, independent of workspace records and live PTY handles. The terminal store migration removes known legacy chat/task/evaluation tables once and preserves `task_workspaces`. Opening the new store in tests does not touch the user’s application database. Agent PTYs launch an executable and argv directly, deduplicate concurrent requests for the same session and retain the existing output bounds and process cleanup.
- New terminal desktop backend and API contract: project opening without invented chat sessions; agent session creation/start/stop/open/rename/archive/delete; workspace associations and active selection; concurrency guards per canonical checkout; separate worktree execution; file editing and review; safe worktree removal; bounded startup workspace reconciliation; shutdown drains pending requests and PTYs. The production app now uses this backend and terminal-only IPC.

Evidence: typecheck and nine focused tests pass. Tests cover missing/installed aliases, required commands, non-file executable rejection, fresh availability checks, unsafe resume IDs, legacy-table removal, migration repeatability, durable IDs and workspace ownership, direct literal argv, real native PTY I/O and cleanup, concurrent worktrees, navigation retaining both PTYs, actual changed-file review, conservative worktree removal and passing an exact persisted native ID on restart. Fixture processes are stopped before teardown.

A live read-only install scan detected Codex, OpenCode, Pi, Antigravity and Kimi on this Mac. This is installation evidence, not end-to-end verification of these CLIs or their authentication.

## Required remaining work

1. Capture native session identity and provide native resume picker behavior where exact metadata is unavailable. Resume supported CLIs on restart without guessing a global last conversation; clearly label fresh-start behavior for non-resumable agents. Exact manually saved native IDs are already supported.
2. Verify installed agents through actual Electron terminal interaction, including concurrent isolated sessions, background review refresh, model/authentication handled inside the CLI, and restart/native resume. The desktop fixture proof does not substitute for this.
3. Complete the launch/capability audit across the referenced catalog and the requirement-by-requirement completion audit, including lifecycle races, utility terminals, missing/removed workspaces and process cleanup. Fix material gaps and run affected checks.

## Desktop cutover checkpoint

The production renderer now hosts agent CLI terminals in the main pane. The desktop shell, project/session sidebar, themes, resizers, optional workspace shells, file editor and diff review remain. The creation dialog searches all 45 catalog choices, refreshes installation detection, offers missing-agent installation links and supports new/existing worktrees. No model settings, chat composer, task protocol, approval cards or native-chat adapters remain. The built-in application engine, model SDKs, provider configuration/credential implementation, old protocol adapters and their obsolete tests have been removed; 219 installed dependency packages were removed. The explicitly authorized one-time legacy-data reset is activated through the new terminal store.

Visible review refreshes every 2.5 seconds with one request in flight and pauses while the document is hidden. Live terminal views stay mounted across navigation to preserve alternate screens. Utility terminal creation and lists explicitly exclude agent PTYs.

Validation: `pnpm check`, `pnpm desktop:build` and the full remaining suite of **27 tests** pass. The real Electron fixture smoke passes keyboard input, all 45 picker entries, isolated worktree creation, concurrent terminal navigation, actual Git review, editing, exact saved-native-ID relaunch and application restart. Dark/light/narrow screenshots were visually inspected. Evidence: `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791639157703`; owned terminal PIDs were confirmed stopped. This is a fixture CLI, not installed-agent completion evidence.

The benchmark fixture now uses 24 terminal sessions instead of deleted chats. One local sample passed: startup 1,241.8 ms, painted switch median 49.1 ms, summed process RSS 1,130,416 KB after opening eleven fixture terminals. It is a smoke measurement, not a comparative performance claim. Report: `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-benchmark-1791639288168/report.json`.

Still required: native resume identity capture/native resume picker behavior for supported CLIs, installed-agent verification through the actual Electron terminal, and final requirement-by-requirement audit. The desktop cutover is working; the complete terminal-agent goal remains **in progress**.
