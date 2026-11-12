# Shared agents

When more than one agent runs in the same workspace, Kairo warns that they edit the same files,
and offers a separate workspace instead.

## Sub-features

- `shared-chip` shows "N agents share these files" next to the workspace name for two or more
  running agents.
- `shared-dialog-single` warns in the new-agent dialog when one agent is already running.
- `shared-dialog-plural` warns with the count when several are running.
- `shared-separate-workspace` swaps the dialog for the new-workspace dialog.

## How to get to it (user POV)

- The chip beside the workspace name in the top bar (`.shared-chip`).
- The `+ Agent` button (`[aria-label="New agent tab"]`) opens the new-agent dialog
  (`.new-session-dialog`) with the warning (`.shared-warning`).

## Driving it with control.mjs

Preconditions: baseline launch, `doctor` all ok. Only `ticker` is running.

- **Baseline.** Run `eval "document.querySelector('.shared-chip')?.textContent ?? null"`. Expect `null`.
- **Single agent.** Run `click '[aria-label="New agent tab"]'`, `wait "!!document.querySelector('.shared-warning')"`, `text ".shared-warning"`. Expect text starting "An agent is already running here."
- **Separate workspace.** Run `click ".shared-warning button" --text "Use a separate workspace instead"`, then `wait "!!document.querySelector('#workspace-create-title')"` and `text "#workspace-create-title"`. Expect "New workspace" and `eval "!!document.querySelector('#new-session-title')"` to print `false`. Close with `click ".new-session-dialog button" --text "Cancel"`.
- **Second agent.** Run `start-session quiet`, then `wait "document.querySelector('.shared-chip')?.textContent.includes('2 agents share these files')"` and `screenshot shared-chip`.
- **Plural warning.** Run `click '[aria-label="New agent tab"]'`, `wait "!!document.querySelector('.shared-warning')"`, `text ".shared-warning"`. Expect "2 agents are already running here." Run `screenshot shared-warning`, then cancel the dialog.

## Gotchas

- The chip counts running agent sessions only. Plain terminals and stopped agents do not count.
- The workspace dialog shares the `.new-session-dialog` class with the agent dialog. Use the
  title ids (`#new-session-title`, `#workspace-create-title`) to tell them apart.
- Cancel the dialog before the next step. An open dialog blocks clicks behind it.
