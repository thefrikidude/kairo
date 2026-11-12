# Git review

The Review tab lists the workspace's changed files and shows the selected file's diff, so a user
can read exactly what an agent wrote without leaving the app.

## Sub-features

- `review-list` lists changed files with their Git status.
- `review-diff` shows the selected file's diff.
- `review-scope` switches between task changes and the working tree.

## How to get to it (user POV)

- `[aria-label="Review changes"]` opens the side panel, then the `Review` tab (`[role=tab]`).
- The Review tab shows every changed file as a stacked diff card (Pierre `CodeView`, rendered in shadow DOM, so file text is not in `innerText`). Each card header has a collapse chevron, `+N`, a viewed check (`.review-viewed`) and open in Cursor. `.review-summary` shows the file count, totals and the Unified/Split and Collapse all buttons.

## Driving it with control.mjs

Preconditions: baseline launch, `doctor` all ok, `ticker` working.

- **Create a change.** Run `wait-agent ticker --state working`, then `agent-write ticker notes.txt "hello diff"`.
- **List.** Run `click '[aria-label="Review changes"]'`, `wait "!!document.querySelector('[role=tab]')"`, `click '[role=tab]' --text Review`, `wait "!!document.querySelector('.review-summary')"`. Run `eval "document.querySelector('.review-summary').innerText"`. Expect `1 file +1 −0`.
- **Viewed.** Run `eval "document.querySelector('.review-viewed').click()"`. Expect `1 viewed` in the summary and the card collapsed.
- **Proof.** Run `screenshot review-diff`. The card header and the added line are both visible.

## Gotchas

- New untracked files show the `??` status and appear without staging.
- The panel refreshes about every 2.5 seconds, so `wait` for the entry instead of reading once.
- A change made by a fixture agent only appears after the agent's write completes. Use `wait`.
