# Terminal tabs

A workspace shows one tab per agent session and per plain terminal. A user can add a plain
terminal, switch between tabs, and keep every terminal running while another is in front.

## Sub-features

- `tabs-list` shows an agent tab per session, with stopped sessions marked.
- `tabs-new-terminal` adds a plain shell tab and selects it.
- `tabs-switch` brings a tab to the front without stopping the others.

## How to get to it (user POV)

- The tab strip at the top of the main pane (`.terminal-tabs`, role `tablist`).
- The `+ Terminal` button (`[aria-label="New terminal tab"]`).
- Click any tab, or use the tab keyboard navigation.

## Driving it with control.mjs

Preconditions: baseline launch, `doctor` all ok, `ticker` working.

- **List tabs.** Run `eval "[...document.querySelectorAll('.terminal-tabs [role=tab]')].map(t=>t.textContent.trim()+':'+t.getAttribute('aria-selected'))"`. Expect `Ticker agent:true` and `Quiet agent · stopped:false`.
- **Add a terminal.** Run `click '[aria-label="New terminal tab"]'`, then `wait "document.querySelectorAll('.terminal-tabs [role=tab]').length===3"`. Re-run the list command. Expect a selected `Terminal 1` and `Ticker agent:false`.
- **Switch back.** Run `click '.terminal-tabs [role=tab]' --text "Ticker agent"`, then `wait "[...document.querySelectorAll('.terminal-tabs [role=tab]')].find(t=>t.textContent.trim()==='Ticker agent')?.getAttribute('aria-selected')==='true'"`.
- **Proof.** Run `wait-agent ticker --state working` to show the agent kept running while hidden. Run `eval "window.kairo.bootstrap().then(b=>b.terminals.map(t=>({agent:!!t.sessionId,state:t.state,activity:t.activity})))"`. Expect two running terminals, the agent `working` and the shell `idle`. Run `screenshot terminal-tabs`.

## Gotchas

- A stopped session still has a tab, so counts include it. Assert on tab text, not only on count.
- xterm renders terminal text outside `innerText`. Read terminal output through
  `window.kairo.attachTerminal(id)` or `wait-agent`, not by reading the DOM text.
- Pressing Esc while a terminal has focus goes to the CLI. Focus a non-terminal element first.
