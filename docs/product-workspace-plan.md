# Lightweight agent workspace: audit and delivery plan

This direction was superseded by the user’s terminal-only agent pivot on 10 October 2026. See [terminal-agent-desktop-plan.md](terminal-agent-desktop-plan.md) for the active implementation checkpoint. The workspace, files and review foundations remain applicable.

Audit date: 2026-10-10. Baseline: `476a58a`; clean working tree.

## Existing foundation

- Electron main/preload/renderer, with a separate Node backend and trusted IPC sender checks.
- Built-in providers, Codex App Server and OpenCode ACP adapters; native authentication, streaming, cancellation, approvals, questions, agent switching and durable handoffs.
- Independent runtime maps by session, background runs that survive navigation, sidebar project grouping, pins, archives, themes and a resizable sidebar.
- SQLite conversation, task, event, checkpoint and runtime persistence. Interrupted tasks recover on restart.
- Workspace-relative file tools with realpath/symlink checks, file read/write IPC, Git changed-path listing and unified patches including untracked files.
- Task evidence and verification are already recorded. The review pane is optional, but eagerly fetches every patch and has no file browser or per-file navigation.

Baseline validation: 139 tests passed. This is a local test baseline, not proof that installed real agents are authenticated or work end-to-end.

## Gaps and constraints

`Session.workspace` is a path, not a workspace entity. There is no repository identity, durable branch/base reference, managed-worktree catalog, or creation/removal lifecycle. Concurrent runtimes are supported but can write to the same checkout. Changing a path on an existing conversation would risk resuming a vendor session against a different directory.

Session titles derive from the first user message. Waiting sessions look like running sessions. Session creation unnecessarily requires choosing a folder again. The review panel has a fixed width and opens all diffs at once; file APIs exist without a browsing interface. The agent file reader truncates output, so it must not be reused for an editable full-file buffer. There is no PTY, terminal transport or terminal UI.

## Incremental implementation and dependencies

1. **Workspace foundation.** Keep chat primary. Add durable rename, clear session statuses, reuse the current project when creating a chat, project navigation, optional resizable Files/Changes tabs, and a lazy directory browser with safe previews. Extract new UI into focused components. Retain the existing review flow while the next layer is built.
2. **Workspace identity and worktrees.** Add a domain `TaskWorkspace` (repository path, working directory, branch/base and ownership), durable workspace records and a session workspace ID. Migrate existing sessions without losing IDs, runtime state or messages. Keep a resolved working-directory projection for existing agent/tool boundaries. Add asynchronous Git discovery/create/select/remove operations with argv-based commands, unique managed paths, and no force removal. Refuse removal with dirty files, active sessions or live terminals. Shared-checkout execution must be explicit; isolated worktrees enable concurrent editing. Never automatically delete a workspace when deleting a chat.
3. **Review and files.** Read changed paths first, fetch only the selected diff, add changed-file navigation and unified/split views, file search, syntax styling, safe editing with unsaved buffers and conflict detection. Refresh active workspace changes after agent operations and on demand. Explain whether changes are working-tree edits or commits relative to the task base. Preserve task summaries and verification evidence alongside review.
4. **Terminal.** Add a separate workspace-scoped PTY service and narrow trusted IPC. Lazy-load an ANSI terminal renderer and sizing addon. Provide tabs in a hidden bottom panel. Retain terminal sessions across chat navigation; kill their processes on explicit close and app shutdown. Keep shell input entirely separate from native agent protocols and approval decisions.
5. **Polish and evidence.** Keyboard shortcuts, loading/error/empty states, focus handling, narrow-window and theme checks. Measure startup, memory and switching before/after with a documented reproducible local setup. Document capabilities and limits; verify the complete restart/isolation workflow with real Git repositories and fixture agents, then real installed agents where credentials are available.

## Files affected

- `src/domain/task-workspace.ts`: new workspace contract.
- `src/infrastructure/persistence/sqlite-session-store.ts`: migrations, workspace associations and explicit session titles.
- `src/infrastructure/repository/`: Git worktree lifecycle/discovery.
- `src/infrastructure/tools/workspace-files.ts`: directory/preview/edit boundary; preserve tool safeguards.
- `src/interface/desktop/backend/index.ts`: workspace use cases, session execution ownership and runtime validation.
- `src/interface/desktop/shared/api.ts`, `preload/index.ts`, `main/index.ts`: narrow IPC contracts and terminal lifetime.
- `src/interface/desktop/renderer/src/ui.tsx`, `style.css` and new contextual components: navigation, creation, files, review and terminal.
- Persistence/backend/Git/file tests and desktop smoke scripts: migration, isolation, dirty-worktree preservation, correct cwd, navigation races and UI evidence.

## Safety and failure handling

- Worktrees isolate file ownership, not shell execution at the OS level. Preserve command approvals, cancellation and existing Codex sandbox settings; do not claim a uniform sandbox.
- Canonicalize working directories before ownership checks. Reject invalid/outside/symlink paths at every file boundary; do not trust renderer workspace identifiers.
- Serialize lifecycle mutations per repository; Git failures must not leave a chat pointing at an absent folder. Preserve created work on persistence failure and report recovery details.
- Workspace removal must account for staged, unstaged, untracked and ignored data as well as commits not merged into the base. Keep unfinished work and prefer an actionable refusal over destructive cleanup.
- Runtime cancellation is asynchronous. Wait for a run to stop before changing its runtime or removing its workspace. Native external session IDs stay attached to their original chat and directory.
- File saves must use complete buffers and detect external edits. Never save a truncated preview over the original.
- SQLite migrations are additive and repeatable. Restart must retain workspace associations, conversations and interrupted-run evidence; terminals are explicitly ephemeral.
- Limit scans and retained output. No ref-by-ref history fan-out or whole-repository scan on streaming chunks.

## Orca references

Local reference checkout: `/Users/itsmanan/Computer-Science/Open_Source/orca`.
Its workspace/session API demonstrates separating persisted ownership from terminal surfaces; `src/main/worktree-create-base.ts` demonstrates validating saved base refs and falling back safely. Kairo will use those principles with its own smaller contracts, rather than importing Orca's remote execution and terminal-pane architecture. No Orca source has been copied in the audit.

## Delivery log

Implementation and measured validation are recorded here per phase. Remaining phases stay open until the complete developer workflow is demonstrated.

### Phase 1 — delivered

- Durable rename with additive legacy-schema migration; names retain conversation/runtime identity.
- Sidebar state indicators include persisted completed, failed, interrupted and verification-required task states; waiting chats remain distinguishable during navigation.
- Current-project and current-agent defaults, project-level session creation and a project selector.
- Optional resizable Files/Changes context with lazy folder browsing, complete bounded read-only previews, shortcuts and session-scoped navigation guards. Escape closes context before stopping a run.
- Dedicated desktop file reader rejects escaping paths, symlinks outside the workspace, binary/non-UTF-8 buffers and files above 1 MB. Previews above the agent's 48 KB output cap are complete.
- Real Electron smoke harness (`pnpm build`, `pnpm desktop:build`, then `node scripts/desktop-smoke.mjs`) uses an isolated temporary state directory and exercises preload/backend IPC. It renames a chat, creates a chat using project defaults, browses/reloads files, resizes context, switches sessions, checks the narrow-window footer and captures dark/light screenshots. It quits the app and cleans fixture state.

Validation: `pnpm check`, desktop build and all 143 tests passed. After the last migration assertion, the 18 focused persistence/file tests passed again. Desktop smoke passed; screenshots were visually inspected. No smoke/backend processes remained afterward.

Local single-run measurements: 1,044 ms from the Electron smoke entrypoint to a selected chat; 61 ms from a session click to the selected title. Electron process working sets at the end of that fixture run: browser 123,840 KB, GPU 89,712 KB, utility 24,960 KB, renderer 87,856 KB. The Node backend is not included in `app.getAppMetrics()`. These are observations for this machine/fixture, not performance guarantees or evidence of improvement over the pre-change version. They establish the first instrumented baseline for later phases. Evidence was captured under `/tmp/kairo-phase1-ui` during this run; future runs choose a fresh temporary evidence directory unless `KAIRO_SMOKE_OUTPUT` is set.

Still open: distinct workspace persistence and managed Git worktrees (Phase 2), editable buffers/syntax and per-file split review (Phase 3), PTY terminal (Phase 4), full-workflow and comparative performance evidence (Phase 5). File previews are intentionally read-only in this increment. There is no automatic agent delegation.

### Phase 2 — delivered

- Added `TaskWorkspace` and a durable workspace catalog. Sessions reference workspace IDs and expose a resolved directory projection for existing adapters and tools. Additive migration backfills existing and archived chats; canonical aliases reconcile without replacing native conversation IDs or messages.
- Async Git discovery, serialized creation, existing-worktree selection and conservative removal. Starting commits are recorded for task review. New worktrees use unique paths under the state directory; creation does not copy uncommitted source edits or run dependency setup.
- Git project creation defaults to an isolated worktree, with branch/base controls and optional folder/existing-tree modes. Sidebar grouping uses repository identity and shows worktree branches. Settings → Workspaces exposes managed lifecycle independently of chat lifetime.
- Canonical overlapping-directory leases prevent simultaneous agents editing the same checkout, including parent/child folders. Independent worktrees can run concurrently. All adapters and file/review requests retain the associated working directory; runtime switching retains workspace identity.
- Removal requires archived associated chats and no active runs; Git guards preserve dirty, untracked, ignored and unmerged work. Primary/unmanaged trees cannot be removed. Branches and archived chat history remain. Workspaces survive chat deletion.
- Shutdown now drains accepted desktop requests before closing SQLite and prevents a delayed send from starting after shutdown begins.

Validation: all 151 tests passed; `pnpm check` and desktop build passed. Real Git fixtures covered concurrent creation, independent files, foreign-worktree rejection, dirty/ignored/unmerged preservation, workspace/catalog restart, canonical alias migration, shared-folder refusal and removal with retained chat history. Electron smoke created a real worktree through the UI, verified its repository/directory association, browsed files, switched sessions and reopened Kairo with the same workspace/session IDs. The final two-launch smoke finished without runtime errors. Local fixture timings were 1,356 ms to the selected chat and 62 ms to switch; this fixture now includes Git discovery and is not directly comparable to the plain-folder Phase 1 fixture. Screenshot/metric evidence is under `/tmp/kairo-phase2-ui` for this run.

Remaining: Phase 3 review/file editing, Phase 4 terminal, and Phase 5 full-workflow/performance polish. Workspace Git branch metadata is refreshed on discovery/startup; live status refresh belongs to the review increment. Removed-worktree chats keep their archived history and cannot be resumed in another directory.

### Phase 3 — delivered

- Async changed-file discovery and lazy selected-file patches replaced synchronous Git and eager per-file patch loading. Git workspaces, including primary checkouts and adopted worktrees, record a starting commit for review, so agent-created commits remain visible. Working-tree scope remains available for staged/unstaged/untracked edits. Native task results retain committed changed paths and require verification for changed work.
- Added changed-file navigation, previous/next controls, unified/split views, selected-file counts, and internal file opening. Recorded task results, verification commands/output and durable activity remain inspectable after navigation/restart. Native Codex file-change paths and ACP locations become bounded, workspace-relative file links; paths outside the owned directory are excluded.
- Added a lazy expandable file tree, explicit filename search, selected syntax grammars and a small editor. Complete-buffer snapshots have content revisions; atomic saves refuse stale revisions, preserve executable permissions and ordinary CRLF/BOM text, and never save a truncated preview. Dirty buffers survive switching chats/panels. Native close/quit confirmation occurs before backend shutdown, so choosing Keep editing leaves the runtime usable.
- Virtualized file/change lists and diff rows, bounded clean-buffer copies to 20 across workspaces, and memoized saved messages/file views. Dirty buffers are retained until explicitly saved or discarded. Highlighting is limited to small files; complete larger text previews remain plain text.
- Read-only Git review/profiling disables optional index refresh locks. A real large-fixture commit race exposed this issue; the index immutability test and successful concurrent review/commit smoke now cover it. The preload removes Electron IPC implementation prefixes from actionable errors.

Validation: all 168 tests passed; typecheck and desktop build passed. Added real Git coverage for committed task work, staged/unstaged/deleted/renamed/untracked files, NUL-safe filenames, binary patches, subfolder scoping, non-Git folders, unborn repositories, path/symlink escapes, literal wildcard paths, deleted directories and read-only index behavior. File tests cover external-edit refusal, complete buffers, mode preservation, temporary-file cleanup, long filenames, search, CRLF/BOM and bounded clean caching. Native adapter tests verify path reporting and omitted-location updates; backend tests verify path confinement, durable activity and committed task evidence.

Electron smoke exercised creating a worktree, editing/saving, retained drafts across chats/panels, refusal of an external-edit conflict, discard/reload, cancellation of quit with unsaved edits, committed changes in task scope, clean working-tree scope, split review, syntax preview, session navigation and restart. The large fixture contains 1,600 extra files and a 20,000-line replacement patch; assertions keep mounted file/diff rows below 100 and verify the last changed line after scrolling. Dark/light/narrow screenshots and the large patch were visually inspected. Evidence is under `/tmp/kairo-phase3-final`. One earlier smoke emitted a macOS `sandbox_extension_issue_file` warning; it still passed its UI assertions. Stale-save IPC errors are deliberately exercised and displayed to the user; they are expected failures, not runtime crashes. Final fixture measurements were 1,539 ms to a selected chat and 117 ms to switch. This larger fixture and paint-aware screenshot instrumentation differ from earlier runs; comparative performance claims remain deferred to Phase 5.

References: [highlight.js individual grammar imports](https://highlightjs.org/) and [ACP v1 file locations](https://agentclientprotocol.com/protocol/v1/tool-calls#following-the-agent). Codex item shapes were checked against JSON Schema generated by the installed CLI. Orca's read-only Git runner supplied a reference for optional-lock behavior; no Orca source was copied.

Remaining: Phase 4 native terminal and Phase 5 complete-workflow, accessibility and comparative performance audit. Archived removed-worktree history remains persisted; a read-only archived-history view belongs to final UX polish. No automatic agent delegation has been introduced.

### Phase 4 — delivered

Added a workspace-scoped native PTY service, separate from session runtimes, conversations and approvals. The backend loads `node-pty` only on demand. Trusted main/preload IPC carries terminal metadata, snapshots, input, resize and acknowledged output; the renderer never receives Node access. Worktree removal refuses both opening and running terminals. Closing or deleting a chat keeps its workspace terminals; explicit tab close and application shutdown stop shells and their attached descendants. Cleanup retains process identities when termination fails, so retrying close cannot silently drop an unresolved process guard. Deliberately detached daemons remain user-managed.

The optional bottom panel lazy-loads xterm and its fit addon. It supports workspace-specific tabs, keyboard input, ANSI colors, Ctrl+C, resize by dragging or keyboard, hiding without stopping commands, and output replay when remounted. Native replay is capped at 128,000 characters; xterm keeps 1,000 scrollback lines. Output batches bypass React conversation state, and PTY output pauses until the renderer acknowledges enough data. Twenty terminal tabs are the explicit application limit. Terminals are ephemeral and are not restarted after an application restart. Settings → Workspaces provides terminal cleanup even when no chat remains for their workspace.

`Cmd/Ctrl+Backquote` toggles Terminal; Escape inside it goes to the shell rather than cancelling an agent. The install hook restores executable permissions on node-pty's installed POSIX spawn helper, which otherwise failed to launch on this Mac. The native binding runs in the existing Node backend, without rebuilding SQLite for Electron. Codex/OpenCode adapters and their approval protocols remain unchanged.

Validation: `pnpm check`, `pnpm desktop:build` and the complete suite passed (173 tests). Native tests cover cwd, independent tabs, ANSI, resize, Ctrl+C, foreground/background child termination, creation/shutdown races, input bounds, output backpressure and bounded replay. Backend tests verify terminal lifetime across chat switching/deletion, independent agent cancellation, refusal to remove a worktree with an open terminal, and runtime shutdown.

Electron smoke exercises actual xterm keyboard input, colored output and cwd; hide/reopen; multiple terminal tabs; isolated-worktree switching; resize; cleanup from Settings; and restart with saved workspace/session associations but no terminal processes. Every recorded PTY PID was gone after quit. The large fixture also passed alongside the 1,600-file explorer and 10,000-line review. Screenshots were inspected in light mode and a narrow window. Evidence: `/tmp/kairo-phase4-terminal-final` (large fixture), `/tmp/kairo-phase4-catalog-final` (final Settings cleanup). Expected stale-editor conflict errors are deliberately exercised by the existing smoke; they are not renderer failures.

Single-run observations: large fixture startup 2,090 ms and session switch 67 ms; final smaller fixture startup 1,434 ms and switch 64 ms. The latter Electron working sets were browser 115,136 KB, GPU 65,344 KB, utility 26,672 KB and renderer 129,648 KB. These exclude the Node backend and are not comparable before/after benchmarks. Terminal code is in a separate ~425 KB lazy renderer chunk; its native service is not spawned at startup.

Phase 5 remains open. Finish the read-only archived-history view; protect shared Git checkout state across sibling-folder sessions; refresh review when another chat in the same workspace changes files; improve modal focus and keyboard navigation; audit startup hydration and measure comparable startup/memory/switching samples; and verify the combined workflow with installed agents where credentials are available. The goal is not complete until that audit and the full definition of done pass.

### Phase 5 — workspace recovery and keyboard progress

Execution and file-save guards now use the canonical Git checkout root rather than only the selected directory. Chats retain their original cwd and file boundaries, but sibling subfolders cannot run agents against one shared index/branch at the same time. A new integration test proves the sibling-run/save refusal, release after cancellation, and concurrent operation in a separate worktree. Plain folders retain canonical directory-overlap guards.

Added an on-demand, SQLite-only archived-history API and viewer. Viewing keeps the active chat and native session identity unchanged; no filesystem or agent runtime is needed. Settings → Archived chats → View shows saved messages and the last task's summary, plan, recorded activity and verification output. Older messages/activity load in batches of 50. Restore is disabled for a removed worktree, while View remains available. The backend test reads a completed chat after actual worktree removal and verifies the active session is unchanged. Electron smoke seeds a removed-worktree history fixture and inspects it through the native renderer/preload/backend bridge.

Session creation, renaming and project deletion now use native modal dialogs to constrain keyboard focus and restore it after dismissal. Global workspace shortcuts do not act behind an open modal. Electron smoke verifies repeated Tab stays inside the rename/create dialogs, Shift+Tab wraps correctly, Escape dismisses creation, and focus returns to New agent session. Archived-history screenshots were inspected in light mode at the narrow-window size. The final smoke also repeats files, review, terminal ownership/cleanup and restart checks.

Review refresh now follows workspace identity when another chat emits a finished tool or completed turn. Finished task events also update the sidebar's persisted-status projection; `verification_required` takes precedence over a live `complete` state, so it remains amber before and after restart. Full-workflow agent verification remains necessary for the final completion audit.

Validation: typecheck, desktop build and all 174 tests passed. Electron smoke/restart passed; evidence is under `/tmp/kairo-phase5-focus` and `/tmp/kairo-phase5-history`. The final focus fixture observed startup 1,284 ms and switch 63 ms; these remain single-run observations, not a comparative performance claim. The Mac emitted one sandbox-extension warning while all renderer checks passed. No smoke/backend processes remain.

Still required before goal completion: comparable startup/memory/switching benchmarks and any resulting startup hydration fixes; keyboard navigation audit for contextual/terminal tabs; installed-agent end-to-end verification, including switching running sessions, approvals, background workspace review refresh, and restart; and the requirement-by-requirement definition-of-done audit. Phase 5 is in progress, not complete.

### Paused checkpoint — 10 October 2026

The user requested wrapping up and pausing before their usage limit. All latest changes are committed; the goal is deliberately unfinished.

Startup workspace reconciliation now uses four concurrent workers rather than refreshing every directory serially. This still refreshes all workspace records and retains missing-folder history. The new test proves the four-worker bound and durable history. Contextual and terminal tablists now have roving keyboard focus with Left/Right and Home/End; changing a terminal tab with the keyboard no longer moves focus into its shell unexpectedly. The final Electron smoke exercises those keys alongside the existing modal, files, diff, terminal, archive and restart workflow.

Installed-agent evidence: both Codex and OpenCode were authenticated. `scripts/native-workflow-smoke.mjs` ran real native-protocol tasks concurrently in distinct worktrees. Each created its own proof file, executed a Node content check, left the primary and other worktree unchanged, produced a reviewable patch, and retained its native conversation ID and workspace association after reopening SQLite. The native task status remains `verification_required`, because Kairo does not independently certify an agent's own reported check. No approvals were requested by these ordinary in-worktree tasks; approval behavior remains covered by protocol/backend tests rather than this native smoke. Evidence: `/tmp/kairo-native-workflow-final/native-workflow.json`.

The first Codex attempt exposed a local CLI configuration mismatch: configured default `gpt-6.1-sol` was not available for this ChatGPT account's live model catalog. Rerunning with an explicit `gpt-6-sol` selection passed. The user's CLI configuration was left unchanged; README already documents selecting an available model when the default is unsupported.

Repeatable benchmark: `scripts/desktop-benchmark.mjs` creates the same fixture shape for each revision (24 Git workspaces, 100 files, 10 messages/chat, three fresh app launches, ten painted session switches/launch). Fresh application data is used per sample; OS caches are not flushed. Baseline source is commit `73ae609`; the after run includes the four-worker startup change now committed as `da1fb2d` and the tab-navigation change. Raw after-report HEAD metadata still names its parent because the changes were measured before committing. The benchmark's resident-memory sampling includes the Electron process family, Node backend and owned agent children, excludes the observing `ps` process, and counts shared pages repeatedly.

| Quiet local samples           |     Before |      After |
| ----------------------------- | ---------: | ---------: |
| Median startup                | 1,704.8 ms | 1,306.0 ms |
| Median painted session switch |   49.75 ms |   49.80 ms |
| Median summed process RSS     | 602,000 KB | 613,360 KB |

Reports: `/tmp/kairo-benchmark-baseline-final/report.json` and `/tmp/kairo-benchmark-after-quiet/report.json`. The observed startup median decreased; switching was unchanged. RSS samples overlap substantially (before 549,472–603,856 KB; after 537,776–632,736 KB), so no memory improvement is claimed. Three samples on one Mac, sequential before/after runs and warm-cache effects limit attribution. An earlier after run overlapped the test suite and is excluded from the comparison.

Final gates for this checkpoint: `pnpm check`, `pnpm desktop:build`, all 175 tests, and Electron smoke/restart passed. UI evidence: `/tmp/kairo-phase5-tabs-final`. Expected stale-editor conflict errors are intentionally exercised. Started benchmark, native-agent and smoke processes have exited.

Resume here:

1. Run the installed agents through the actual Electron conversation UI together; verify switching running chats and background review refresh for another chat sharing a workspace. The real native backend smoke and the Electron fixture smoke have passed separately; the combined UI/native run is still unverified.
2. Finish the requirement-by-requirement completion audit against the attached specification, including approval UX, cancellation/recovery, lazy loading and process cleanup. Fix any material gaps the audit finds.
3. Re-run only checks affected by further changes and document final evidence. Mark the goal complete only when the full developer workflow is proven. No automatic agent delegation should be added.
