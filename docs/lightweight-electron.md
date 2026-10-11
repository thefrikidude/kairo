# TypeScript/Electron resource checkpoint

Kairo retains TypeScript, React, Electron, SQLite and node-pty. This checkpoint reduces runtime overhead without changing durable workspace/session data or adding dependencies. It does not establish that the whole application is lightweight.

## Changes

- Vite compiles and minifies the backend into `out/main/backend.js`. Electron launches that JavaScript directly with Node, removing the tsx loader process and runtime source compilation. `tsx` is removed from development dependencies. Node remains required; `KAIRO_NODE_EXECUTABLE` optionally selects its executable.
- Renderer assets are minified. Uncompressed renderer output falls from 1,388,068 to 733,308 bytes (47.2%); total build output falls from 1,401,672 to 809,459 bytes (42.2%). These figures exclude Electron and external backend dependencies.
- Mounted terminals share one preload output subscription and one theme observer. Hidden terminals disable accessibility DOM and resize observation, while retaining their xterm parser, alternate screen and scrollback. The active terminal retains accessibility support.
- Clean editor buffers retain at most 20 files and an estimated 8 MiB of UTF-16 text. Dirty buffers are exempt. This is a cache budget, not a limit on unsaved user work.
- Renderer state notifications coalesce and serialize bootstrap reads. Navigation requests omit archived sessions and preparation bodies; archive history and setup output are fetched when opened. The default full bootstrap remains available. New narrow API methods are `archivedSessions()` and `preparation(id)`; `bootstrap(true)` requests navigation data. Operation summaries have a distinct TypeScript type.
- Native identity polling deduplicates identical lookups within a scan, skips inactive terminals during periodic scans, and backs off from 1.5 to 5 seconds when unchanged. Explicit stop/shutdown capture remains intact. No database migration or session-ID change is introduced.

## Matched measurements

Apple M2, macOS arm64, Node 24.21.0, Electron 44.4.5. Baseline source is `0f16fda`; optimized runtime source is `786111b`. Each fixture has five fresh launches, 24 workspace/session records and 100 files. Interactive samples open eleven fixture agents, emit 4,000 noisy output lines in an additional shell, close terminals, then exercise three shell open/close cycles. Idle samples have no live terminals. Runs are sequential; caches are not flushed.

The first interactive baseline overlapped a test run and was excluded. Its replacement ran without tests or another benchmark. The idle baseline, interactive after run, idle after run, and replacement interactive baseline ran in that order. Warm caches and run ordering limit attribution.

| Median unless stated                     |      Before |       After |
| ---------------------------------------- | ----------: | ----------: |
| Idle startup                             |    895.9 ms |    682.4 ms |
| Interactive startup                      |  1,185.7 ms |  1,032.3 ms |
| Painted switch, p95 across 50 switches   |    100.5 ms |    100.0 ms |
| Idle Kairo-owned RSS                     |   479.3 MiB |   443.2 MiB |
| One-terminal Kairo-owned RSS             |   503.3 MiB |   455.5 MiB |
| Eleven-terminal Kairo-owned RSS          |   551.5 MiB |   518.9 MiB |
| Eleven-terminal total workload RSS       | 1,077.8 MiB | 1,050.6 MiB |
| Noisy-output Kairo-owned RSS             |   539.3 MiB |   472.6 MiB |
| Post-close Kairo-owned RSS               |   496.9 MiB |   467.3 MiB |
| After three additional open/close cycles |   455.9 MiB |   408.9 MiB |

Kairo-owned RSS includes the Electron process family and backend, excluding terminal shell PIDs and their descendants. Total workload includes them. Both versions use `ps` resident memory in KiB; shared pages can be counted repeatedly. Memory is sampled at the same fixture stages, separately from the final sample-level RSS field.

Idle and eleven-terminal medians decreased by 7.5% and 5.9%, respectively. Sample ranges overlap; these are observations on one machine, not performance guarantees or proof of a 25% memory reduction. Three recovery cycles do not establish long-term absence of leaks. Electron's installed `.app` alone occupies approximately 288 MiB here; no final packaged Kairo application size is claimed.

Sanitized reports retain every timing and memory sample with process counts instead of PIDs:

- [Before idle](performance/electron-before-idle.json) and [after idle](performance/electron-after-idle.json).
- [Before interactive](performance/electron-before-interactive.json) and [after interactive](performance/electron-after-interactive.json).

Reproduce using the same harness and fixture agent against separately built baseline/after checkouts, each with its own compatible dependencies:

```sh
pnpm build
pnpm desktop:build
KAIRO_BENCH_RUNS=5 KAIRO_BENCH_OUTPUT=/tmp/kairo-interactive node scripts/desktop-benchmark.mjs
KAIRO_BENCH_RUNS=5 KAIRO_BENCH_EMPTY=1 KAIRO_BENCH_OUTPUT=/tmp/kairo-idle node scripts/desktop-benchmark.mjs
# Optional positional argument selects another checkout's built desktop host.
KAIRO_BENCH_RUNS=5 node scripts/desktop-benchmark.mjs /absolute/path/to/baseline-checkout
```

## Verification

Typecheck, desktop build and all 43 tests passed. Electron desktop/restart smoke passed with fixture CLI agents, covering workspaces, independent copies/setup, context menus, palettes, editing/review, shell job control, exact native resume and terminal cleanup. New assertions verify alternate-screen content and the same mounted terminal survive switching, and hidden terminals have no accessibility DOM. Backend tests cover lightweight navigation and explicit detail retrieval; renderer tests cover the byte budget, dirty-buffer preservation and shared output subscription cleanup.

Every recorded benchmark host, backend, shell and agent PID was checked after shutdown. Authenticated real-agent verification was not repeated for this checkpoint.
