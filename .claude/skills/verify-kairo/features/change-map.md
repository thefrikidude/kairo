# Change map

The Map tab draws the workspace's changed files as a graph: files and folders as nodes, import
links as dashed edges. A user reviews each file, approves or flags it, and sees which files two
agents touched. The map can fill the window or open in its own window.

## Sub-features

- `map-graph` draws a node per changed file with live counts in the toolbar.
- `map-contested` rings a file that two agents were working on when it changed, with an
  explanation.
- `map-review` approves or flags a file, and marks an approved file stale when it changes again.
- `map-next` jumps to the next file that still needs review, contested files first.
- `map-expand` fills the whole window and collapses back.
- `map-window` opens the same map in its own window.

## How to get to it (user POV)

- `[aria-label="Review changes"]` opens the side panel. Choose its `Map` tab (`[role=tab]`).
- In the toolbar (`.map-toolbar`): `Next ›`, `Expand`, `New window`.
- Select a file node (`.graph-file`) to see its diff and `Approve`, `Flag` and `Open in Cursor`
  (`.map-actions`).

## Driving it with control.mjs

Preconditions: baseline launch, `doctor` all ok, `ticker` working (`wait-agent ticker --state working`).

- **Open the map.** Run `click '[aria-label="Review changes"]'`, `wait "!!document.querySelector('[role=tab]')"`, `click '[role=tab]' --text Map`, `wait "!!document.querySelector('.map-toolbar')"`.
- **Draw nodes.** Run `agent-write ticker a-solo.txt "one agent"`, then `wait "!!document.querySelector('.graph-file[aria-label^=\"a-solo.txt,\"]')"`.
- **Contested file.** Run `start-session quiet`, `wait-agent quiet --state idle`, then `agent-write quiet shared.txt "both agents"`. Run `wait "document.querySelector('.map-count-contested')?.textContent.includes('1 contested')"`. Select it with `click '.graph-file[aria-label^="shared.txt,"]'`, then `text ".map-contested"`. Expect "Changed while Ticker agent and Quiet agent were working." Run `screenshot contested`.
- **Review marks.** Run `click ".map-toolbar button" --text "Next ›"`, then `click ".map-actions button" --text Approve`. Expect `text ".map-count-approved"` to start with `1`. Select another node with `click ".graph-file:not(.is-approved)"`, then `click ".map-actions button" --text Flag`. Expect `text ".map-count-flagged"` to start with `1`.
- **Stale after re-edit.** Run `agent-write ticker <approved file> "changed again"`, then `wait "document.querySelectorAll('.graph-file.is-stale').length===1"`.
- **Expand.** Run `click ".map-toolbar button" --text Expand`, `wait "!!document.querySelector('.workbench.is-expanded')"`. Then `eval "document.querySelector('.map-toolbar button').focus()"`, `key Escape`, and `wait "!document.querySelector('.workbench.is-expanded')"`.
- **Map window.** Run `click ".map-toolbar button" --text "New window"`, then `windows`. Expect window `1` with a hash starting `#map`. Run `wait "!!document.querySelector('.map-window .graph-file')" --window 1 --timeout 20000` and `screenshot map-window --window 1`.

## Gotchas

- Git workspaces default to the "Task changes" scope. A clean tree reads "No changes since this
  task started", not "Working tree is clean".
- `quiet` only counts as working for about a second after it announces work. Always
  `wait-agent quiet --state idle` first, then write while `ticker` is working.
- Esc in a terminal belongs to the CLI, so focus a toolbar button before `key Escape`.
- After switching tabs the old panel can stay in the DOM hidden for a moment. Wait on the tab's
  `aria-selected`, not on panel existence.
- Approve marks live in the page's localStorage per workspace. A fresh launch starts with none.
- A file's node label shows only after hovering, selecting or in small graphs. Select nodes by the
  `aria-label` prefix, which always carries the path.
