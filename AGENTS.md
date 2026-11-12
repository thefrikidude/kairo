# Kairo: guide for coding agents

Kairo is a small local desktop app (macOS-first) for coding-agent terminals. You open projects,
create workspaces (an existing checkout, a new Git worktree, or a plain folder), run agent CLIs
(Codex, Claude, OpenCode and 40+ more) in real terminals, and review Git changes beside them.
Each agent CLI owns its models, authentication, conversation and approvals.

Stack: TypeScript (strict, ESM), React, Electron, Vite, a Node.js backend, xterm.js + node-pty,
better-sqlite3, and the installed `git` CLI. Node 24.21+ and pnpm are required (see `.nvmrc`).

## Commands

```sh
pnpm install            # postinstall makes node-pty's spawn-helper executable
pnpm desktop:dev        # run the app with hot reload
pnpm check              # typecheck (tsc --noEmit)
pnpm test               # build to dist/ then run node --test on dist/**/*.test.js
pnpm format:check       # prettier (pnpm format to fix)
pnpm desktop:build      # production bundle into out/
```

`dist/` and `out/` are build outputs and are gitignored. Rebuild after changing `src/` before
running anything that loads them, such as the Electron smoke scripts.

## Layout

- `src/domain`: plain types (`TaskWorkspace`, `TerminalSession`, `WorkspaceTerminal`).
- `src/infrastructure`: everything that touches the outside world.
  - `agents`: the 45-agent catalog, install discovery, native-session capture and resume args.
  - `terminal`: PTY management and the working/waiting/idle activity inference.
  - `persistence`: the SQLite store for workspaces and sessions.
  - `repository`, `workspaces`: Git worktrees and workspace lifecycle.
  - `tools`: read-only review (`workspace-review`), the change map (`workspace-map`) and
    per-session change attribution (`change-tracker`).
- `src/interface/desktop`: the app shell.
  - `main` (Electron main process), `preload`, `backend` (Node child process), `renderer`
    (React UI, one `style.css`), `shared` (types shared across the process boundary).
- `docs/`: design notes and measured performance. Read the relevant file before big changes.

## How a request travels

Renderer calls `window.kairo.<method>` → preload → Electron main → backend child process over
JSON lines → `terminal-runtime.ts`. Adding a method means touching all of these:

1. `src/interface/desktop/shared/terminal-api.ts`: the type.
2. `src/interface/desktop/preload/index.ts`: the `invoke` wiring.
3. `src/interface/desktop/main/index.ts`: `handle("channel", "method")`.
4. `src/interface/desktop/backend/protocol.ts`: add the method to the allowed set.
5. `src/interface/desktop/backend/terminal-runtime.ts`: the `handle` switch.

Only the main window is trusted by default. Standalone map windows may call `workspace:map`,
`workspace:diff` and `workspace:open-cursor` only. Keep it that way.

## Conventions

- Imports use the `.js` extension (NodeNext ESM), even for `.ts` sources.
- Prettier: 100 columns, double quotes, trailing commas. Run `pnpm format:check` before finishing.
- Tests sit next to the code as `*.test.ts` and use `node:test` with `node:assert/strict`.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`).
- Comments explain why, not what. Match the surrounding density.
- User-facing errors are full sentences; tests often match them by regex, so do not reword
  existing messages casually.

## Testing notes

- Never touch the real state directory (`~/.local/state/kairo`). Tests and scripts use temp
  directories and `KAIRO_STATE_DIR`.
- Tests that need Git create a throwaway repo in a temp dir; see `workspace-review.test.ts`.
- To verify a UI change in the real app, use the `verify-kairo` skill
  (`.claude/skills/verify-kairo/`). It launches an isolated app with fixture agents and lets you
  click, read and screenshot it through `scripts/verify/control.mjs`.
- No real agent or provider usage is needed. The Electron smoke harness uses a fixture CLI:
  `node scripts/desktop-smoke.mjs` (needs `pnpm build` and `pnpm desktop:build` first).
- One test, `terminal-agent-discovery`, depends on which agent CLIs are installed on the host and
  fails on some machines. Check whether a failure is pre-existing before blaming your change.

## Boundaries and direction

- Terminals are the foundation: agents run as their normal interactive CLIs in a PTY.
- Kairo has no built-in model engine, API-key settings, or automatic agent delegation today.
- Under discussion, not built: a chat mode that drives several agents in one thread through
  Agent Client Protocol (UI to agent), with A2A-shaped tasks for delegation between agents. If you
  work on this, keep terminals fully working and treat chat as an additional mode.
- Git operations shell out to `git` with `GIT_OPTIONAL_LOCKS=0` and literal pathspecs. Keep
  review code read-only so it never refreshes or locks the user's index.
- macOS is the primary platform (for example, "Open in Cursor" is macOS-only).
