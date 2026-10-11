# Workspace workflow checkpoint

Implemented 11 October 2026, starting from `d02c59d` (terminal-only desktop).

## Delivered behavior

- Projects contain named workspaces; each workspace has its own agent and plain-shell tabs, including stopped agent sessions. Existing workspace/session IDs, native resume targets and review baselines are retained through additive migrations.
- New workspace is separate from adding a tab. Task names derive unique branches; users can choose a base/commit, override the branch, adopt an existing worktree, or open a non-Git folder. No agent is required.
- SQLite project preferences hold a default base, optional setup script and explicit ignored paths to copy. Defaults use saved refs, locally known remote defaults, then the primary checkout branch/HEAD. Missing saved refs produce an actionable correction; remote refresh is explicit.
- Creation records its destination before checkout, then prepares in the background. Progress/output, cancel and retry stay separate from navigation. Surviving interrupted checkouts are adopted into the catalog on restart; setup never restarts automatically.
- Copying creates independent files and journals successful copies for retry. It rejects traversal, symlinks, tracked paths, missing sources and destination collisions. Limits: 100 configured paths, 10,000 copied files, 256 MB.
- Setup uses `sh -e` in the destination with `KAIRO_SOURCE_DIR` / `KAIRO_WORKSPACE_DIR`, retains the last 32,000 output characters, and stops owned processes on cancellation/shutdown. The ten-minute limit prevents indefinite setup. Servers belong in normal workspace terminal tabs.
- Workspace names, pins, archive state and remembered tabs persist. Legacy session pins map to workspace pins. Workspace archive closes all attached terminals without changing individual session archive flags or deleting files/branches. Restore does not start all tabs.
- Removal remains separate and refuses dirty/ignored/unmerged work or live processes. Selection refreshes Git metadata in the background; app focus and explicit refresh also reconcile metadata. Missing directories retain history and are labeled unavailable.
- Cmd/Ctrl+J jumps to workspaces/tabs; Cmd/Ctrl+P opens files through the existing bounded search/editor. Palette results are capped; terminal shortcuts are intercepted before reaching the CLI. Agent-tab actions live in a small tab menu.

## Validation

The 40-test suite covers real Git worktrees, safe removal, migrations/restart, exact native IDs, CLI/PTY behavior, archive/restore/process cleanup, preferences, default refs (including non-origin remotes), copy boundaries, failed setup retry, cancellation, interrupted-checkout adoption, external directory disappearance/recovery, and the actual JSON IPC transport.

Typecheck and desktop build pass. The Electron smoke exercises project setup via the UI, background creation while navigating, independent ignored-file copies, scoped agent/plain tabs, file editing/review, keyboard palettes, mouse pin/unpin, workspace and session archives, restoration, normal shell job control, and exact native fixture conversation recovery after restart. It verifies recorded PTYs have exited. Dark/light/narrow and palette screenshots were inspected; dialog overflow and narrow tab layout were corrected.

Fixture smoke evidence: `/tmp/kairo-workspace-smoke-final`. Installed, authenticated real-agent conversation verification remains the separate pre-existing checkpoint; these tests use a fixture CLI and do not consume provider usage.

## Performance evidence

The benchmark uses the same 24-workspace / 100-file / 24-session fixture, initially one live terminal, then ten painted switches opening agent terminals. Three fresh application runs are sampled for each revision. The updated harness supports both the original session sidebar and workspace sidebar; on the latter it opens a stopped agent tab after selecting its workspace. It waits for enabled controls and verifies recorded processes exit after shutdown.

The original `d02c59d` source was built in an isolated temporary checkout using the same Node 24.21.0 and existing dependency installation. Runs were sequential on an Apple M2, with no test suite running concurrently. Earlier harness failures and the initial after run that blocked selection on Git refresh are excluded from the final comparison. Warm caches, different navigation steps and three samples limit attribution; these measurements are observations, not guarantees.

| Median                                    | Before (`d02c59d`) | After (`03ddb1e`) |
| ----------------------------------------- | -----------------: | ----------------: |
| Startup                                   |           881.9 ms |          781.2 ms |
| Painted agent/workspace switch            |           73.75 ms |          74.55 ms |
| Summed process RSS after eleven terminals |       1,064,272 KB |      1,142,288 KB |

Switching is effectively unchanged after moving Git refresh off the selection path. The measured RSS median increased by about 7.3%; sample ranges overlap (before 1,059,072–1,155,344 KB; after 1,138,352–1,223,712 KB), so no memory improvement is claimed. The sums include Electron, backend and children and may count shared pages more than once. Renderer entry JavaScript grew by approximately 21 KB before compression; no dependency was added.

Reports: `/tmp/kairo-workspace-benchmark-before/report.json` and `/tmp/kairo-workspace-benchmark-after-final/report.json`. Every recorded benchmark process was gone after shutdown.

## Boundaries

No new dependencies, provider protocols, agent orchestration, remote hosts, browser, issue trackers, snapshots, automatic disk cleanup, dependency symlinks or Git publishing UI were added. Setup currently requires macOS/Linux. Plain terminal processes remain ephemeral across app quits; remembered live-shell IDs do not recreate every shell. Branches and file edits are not moved between checkouts.
