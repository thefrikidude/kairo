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

## Native recovery checkpoint

Codex/OpenCode identities are captured from their native local stores, using launch-time baselines and canonical workspace paths. Codex's SQLite metadata is preferred; bounded recent rollout metadata is a fallback. OpenCode database selection follows its XDG/OPENCODE_DB configuration. Readers select only native IDs, timestamps and transcript locators; they do not read conversation bodies or credentials and do not write vendor databases. CLI root sessions are distinguished from nested agents. More than one candidate clears the automatic target and requests an exact selection instead of guessing. Metadata flushes before/after stop and shutdown; the interval and in-flight read are drained before closing Kairo's database.

Each session persists its last start time. Supported sessions without a saved native target no longer silently restart fresh: Codex/Claude have CLI-native picker launches, while other providers require an exact Resume ID or an explicitly confirmed fresh start. Unsupported agents reopen fresh with a notice. Codex receives its associated workspace as an explicit `--cd` argument, including on native resume. Full-catalog exact resume arguments and user-saved file locators remain supported. Automatic native-store capture is currently implemented for Codex/OpenCode; other agents use their native picker or a saved ID.

Evidence: the Electron fixture now creates native-shaped Codex rollout metadata and asserts automatic capture before stopping, then exact resume after application restart. Evidence directory: `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791640262723`. The real CLI input, workspace/review/edit workflow and process cleanup also pass. Native-store tests cover unrelated cwd, old sessions, child agents, archived rows, identity/recency baselines, selected OpenCode databases and bounded legacy files. Backend tests cover automatic persistence, ambiguous matches, native-picker fallback, explicit fresh-start recovery and non-resumable agents. Installed-agent end-to-end proof and the final completion audit remain open. Codex authentication was verified live with `codex login status`; no credentials were copied.

Final recovery gates: all **33 tests** pass, including overlapping plain-folder ownership, and typecheck/desktop build/automatic-capture Electron smoke pass. The recovery toolbar wraps at narrow widths. Installed-agent desktop verification remains the next required step.

## Normal shell session update

Agent sessions now launch a normal interactive shell and queue the safely quoted agent command as ordinary terminal input. The shell owns job control and remains open when the CLI exits. **Use shell** sends Ctrl+Z to suspend the foreground agent and focuses the same terminal; `fg` returns to that agent. No second terminal or separate chat UI is needed to run normal commands. Closing the terminal still cleans up the shell and attached processes.

Native PTY tests cover literal arguments, suspension, normal shell commands, foreground resumption, CLI exit returning to the prompt, and independent session cleanup. The installed Codex CLI was also launched in a temporary workspace: suspension and ordinary shell commands in the same PTY passed, and all owned processes were closed afterward. This verifies the shell interaction; the broader installed-agent conversation/restart audit remains open.

Validation: all 33 tests, typecheck and desktop build pass. The Electron fixture smoke and exact-resume restart pass; it clicks **Use shell**, runs a command through the terminal input API and resumes the foreground job. Existing agent keyboard-input checks still pass. Screenshots were inspected at `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791650266490`, including `normal-shell.png`. All fixture terminal processes were confirmed stopped.

## Terminal layout and directory polish

The center now contains the terminal without an agent toolbar or conversation/status notices. Files, Review and optional additional shells are opened from a separate right sidebar. Terminal lifecycle management stays in Settings → Workspaces; keyboard job control remains available directly inside the terminal.

Shell prompts show the full current directory and follow `cd`. New isolated worktrees use a readable task directory and end in the original project folder name, rather than a UUID leaf. Existing worktrees are preserved in place. Native PTY tests verify prompt changes after navigation; Git tests verify readable directory names while preserving independent worktrees.

The actual Electron fixture workflow and exact-resume restart pass, including the right sidebar, file editing, review, normal shell commands and closing terminals through Settings. Screenshots were inspected at `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791651652019`. Owned fixture terminal processes were confirmed stopped.

## Terminal tabs

The center header now contains tabs for live terminals in the selected project, with **+ Terminal** and **+ Agent** controls. Plain shells and agent sessions share the same full-height terminal surface. Switching tabs retains each xterm view and PTY; Files and Review stay in the right sidebar. Additional shells no longer open in a separate bottom panel. Cmd/Ctrl+backquote opens a new terminal tab.

Validation: typecheck and desktop build pass. The Electron smoke creates a shell from **+ Terminal**, switches back to its agent tab, creates an isolated agent from **+ Agent**, edits/reviews files and verifies native resume after restart. Screenshots were inspected at `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791651975092`; all owned fixture processes stopped.

The separate Shell panel and its renderer/styles have been removed entirely. The right sidebar contains Files and Review only. Plain terminals are created through **+ Terminal**, using the same tab/view system as agent terminals.

## Sidebar pin and archive fixes

Pinned sessions now appear in a separate section above Projects, with explicit Pin/Unpin labels and validated saved pin state. Archiving a live session closes its attached terminal first, captures native identity and then archives its metadata. Failed process cleanup prevents archiving. Other terminals and workspace files remain available. Archived sessions can be restored through Settings.

Validation: all 34 tests, typecheck and desktop build pass. The actual Electron smoke uses mouse clicks for Pin, Unpin and Archive, verifies visible placement, preserves unrelated terminals, restores the archived session, and confirms pin persistence and exact conversation resume after restart. Evidence: `/var/folders/3x/rz0dj8y12pz759_q5skzxw380000gn/T/kairo-terminal-evidence-1791652580514`. Owned fixture processes were confirmed stopped.

## Workspace defaults aligned with Orca

Opening a project uses its existing checkout. New agent tabs default to that workspace, including an already selected worktree. The creation dialog no longer forces a new worktree after asynchronous Git discovery; creating an isolated worktree is an explicit choice. Additional agents may share an existing workspace with independent terminals and shared files/Git state. Plain terminal tabs continue to use the current workspace.

Shared directories make native conversation metadata ambiguous for matching agents. Previously captured IDs are preserved, but automatic capture is disabled for newly overlapping launches rather than assigning another agent’s conversation. The native CLI picker remains available on recovery. Worktree removal still requires closing all attached terminals and archiving associated sessions.

Validation: 34 tests, typecheck and desktop build pass. The Electron workflow verifies the project-folder default, explicit isolation, the existing-worktree default and a second agent sharing the same workspace, then checks archival and exact resume after restart.
