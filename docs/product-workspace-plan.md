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
