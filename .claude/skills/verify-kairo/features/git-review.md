# Git review

The Review tab lists the workspace's changed files and shows the selected file's diff, so a user
can read exactly what an agent wrote without leaving the app.

## Sub-features

- `review-list` lists changed files with their Git status.
- `review-diff` shows the selected file's diff.
- `review-scope` switches between task changes and the working tree.

## How to get to it (user POV)

- `[aria-label="Review changes"]` opens the side panel, then the `Review` tab (`[role=tab]`).
- Each changed file is a `.changed-file-button`. The diff appears in `.review-panel`.

## Driving it with control.mjs

Preconditions: baseline launch, `doctor` all ok, `ticker` working.

- **Create a change.** Run `wait-agent ticker --state working`, then `agent-write ticker notes.txt "hello diff"`.
- **List.** Run `click '[aria-label="Review changes"]'`, `wait "!!document.querySelector('[role=tab]')"`, `click '[role=tab]' --text Review`, `wait "document.querySelectorAll('.changed-file-button').length>=1"`. Run `eval "[...document.querySelectorAll('.changed-file-button')].map(b=>b.textContent.trim())"`. Expect an entry ending in `notes.txt` with the `??` status.
- **Diff.** Run `click ".changed-file-button"`, then `wait "document.querySelector('.review-panel')?.innerText.includes('hello diff')"`.
- **Proof.** Run `screenshot review-diff`. The file list and the added line are both visible.

## Gotchas

- New untracked files show the `??` status and appear without staging.
- The panel refreshes about every 2.5 seconds, so `wait` for the entry instead of reading once.
- A change made by a fixture agent only appears after the agent's write completes. Use `wait`.
