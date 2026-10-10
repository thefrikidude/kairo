# Lightweight agent workspace: audit and delivery plan

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
