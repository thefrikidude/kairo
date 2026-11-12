---
name: verify-kairo
description: Drive the real Kairo Electron desktop app the way a user does and capture proof (screenshots, DOM state). Use after changing anything under src/interface/desktop, the terminal or review code, or when asked to verify, test in the app, or prove a UI behaviour works. Not for unit tests (use pnpm test).
---

# Verify Kairo

Kairo is an Electron desktop app. This skill launches the real app against a throwaway state
directory, a throwaway Git project and fixture agents, then lets you click, read and screenshot it
through `scripts/verify/control.mjs`. It never touches the user's real data in
`~/.local/state/kairo` and never runs a real agent.

All commands run from the repo root as `node scripts/verify/control.mjs <command>`. Run it with no
arguments for the full list.

## Launch

1. Build, because the app and the seeding code load build output: `pnpm build && pnpm desktop:build`.
2. `node scripts/verify/control.mjs launch`. It returns when the active agent's terminal is mounted
   and accepting input, which is the usable state, not just an open window.

A launch starts from an empty state. It creates a Git project with two commits' worth of
baseline, a plain folder, and three sessions: `ticker` and `quiet` share the Git project,
`plain` is in the plain folder. `ticker` is the active one and starts with the app.

- The fixture `codex` (alias `ticker`) prints continuously, so Kairo always sees it as working.
- The fixture `claude` (alias `quiet`) is idle until asked, then works for about a second.
- `quiet` and `plain` start stopped. Start them with `start-session <alias>`.

For first-run states, `launch --empty` starts with no projects (home screen), and `launch --empty --with-project` adds the repo as a project with no workspace.

Each launch prints a run ID and the artifacts folder. The newest run is remembered, so later
commands need no flags. For side-by-side runs set `KAIRO_VERIFY_RUN=<run id>` or pass `--run`.

## Doctor

Run `node scripts/verify/control.mjs doctor` first, and again whenever something looks off. It is
read-only. It checks that the app process is ours and alive, the control server answers, the state
directory is the isolated one, no renderer console errors are piling up, the build is newer than
`src/`, and the running commit matches the checkout. A `warn` about a stale build means your
changes are not in the running app: rebuild and relaunch.

## Drive

Drive the UI through stable handles: ARIA labels, roles and the class names listed in each feature
file. Never use coordinates.

| Need          | Command                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Click         | `click '<selector>' [--text 'exact visible text']`                                                       |
| Read          | `text '<selector>'`, or `eval '<js>'` for anything structured                                            |
| Wait          | `wait '<js expression>' [--timeout ms]`, never `sleep`                                                   |
| Agents        | `start-session <alias>`, `wait-agent <alias> --state working\|idle`, `agent-write <alias> <file> <text>` |
| Outside edits | `fs-write <path> <text>`, `fs-rm <path>` (inside the run's project only)                                 |
| Windows       | `windows`, then add `--window N` to eval, click, wait, key, screenshot                                   |
| Keys          | `key Escape` (focus the element first with `eval`, because Esc inside a terminal belongs to the CLI)     |
| Workspace     | `select-workspace shared\|plain`                                                                         |

`window.kairo` is the app's own API in the page, so `eval` can read state such as
`window.kairo.bootstrap()`. Use it to read, not to skip the user path: perform the action by
clicking, and use `eval` to confirm the result.

Read the feature map in `features/README.md` and use the matching file as the recipe.

## Evidence

Save proof into the run's artifacts folder:

- `screenshot <name>` captures that one app window only, never the screen, and refuses paths
  outside the artifacts folder.
- `note <name> '<text>'` saves commands, output or a short observation.
- A proof shows the action and the resulting state, not just the final screen. Read the DOM state
  (`text`, `eval`) alongside every screenshot, because screenshots alone prove little.
- Verify side effects too, for example that a file the agent wrote exists in the Review list and
  that its diff shows the content.
- Report an unreachable path with the command you tried and the unmet precondition. Never report a
  skipped entry point as verified through another one.

## Cleanup

`node scripts/verify/control.mjs cleanup` quits the app, stops only the processes this run
started (never by process name), and deletes the temp project and state. The artifacts folder
under `.kairo/verify/<run id>/artifacts/` is kept. It is gitignored. Run cleanup after every
failed attempt too, so no app or port is stranded. Never drive an instance this run did not
start, and never point this at the user's own running Kairo.

## Helpers

- `scripts/verify/control.mjs`: the CLI above.
- `scripts/verify/host.cjs`: the Electron entry that adds a token-protected control server on
  127.0.0.1. Started only by `launch`.
- `scripts/verify/fixtures/agent-activity.cjs`: the fixture agent.
