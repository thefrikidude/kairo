# Kairo verification map

The maintained source for verifying Kairo's user-facing behaviour. Read this index before driving
the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build first (`pnpm build && pnpm desktop:build`), then `node scripts/verify/control.mjs launch`.
- Run `node scripts/verify/control.mjs doctor` and require every line to be `ok` or an understood
  `warn`.
- The baseline has one Git workspace named `main` with sessions `ticker` (running) and `quiet`
  (stopped), plus a plain folder workspace with a stopped `plain` agent. The project is clean.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Prefer ARIA labels and the listed class names over DOM position.
- Wait on a condition with `wait`, never a fixed delay.
- Start every recipe from the baseline unless its preconditions say otherwise. Relaunch rather
  than undo state.
- Fixture agents write files inside the project, so use `agent-write` for agent edits and
  `fs-write` only to simulate edits made outside any agent.

## Proof and skip reporting

- Capture the action and the resulting state: a DOM read plus a screenshot with the app visible.
- Record the feature ID and entry point used with every artifact name.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behaviour, then exactly four H2
sections in this order: `Sub-features`, `How to get to it (user POV)`,
`Driving it with control.mjs`, `Gotchas`.

## Features

- [Terminal tabs](./terminal-tabs.md) covers agent and plain terminal tabs and switching between them.
- [Shared agents](./shared-agents.md) covers the shared-workspace chip and warning dialog.
- [Change map](./change-map.md) covers the graph, contested files, review marks, expand and the map window.
- [Git review](./git-review.md) covers the changed-file list and diff view.
