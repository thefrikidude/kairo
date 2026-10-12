const { app, dialog } = require("electron");
const assert = require("node:assert/strict");
const { writeFile, readFile, readdir } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const started = performance.now(),
  output = process.env.KAIRO_SMOKE_OUTPUT;
app.setPath("userData", join(process.env.KAIRO_STATE_DIR, "electron"));
let win;
const failures = [],
  pids = new Set();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const evaluate = (code) => win.webContents.executeJavaScript(code);
async function waitFor(code) {
  const end = Date.now() + 18000;
  while (!(await evaluate(code))) {
    if (Date.now() > end) throw new Error(`UI timed out: ${code}`);
    await sleep(30);
  }
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function pointerClick(selector, mouseButton = "left") {
  const point = await evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(document.elementFromPoint(x,y)?.closest('button')!==node)throw new Error('Sidebar action is covered');return {x,y};})()`,
  );
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  await sleep(50);
  win.webContents.sendInputEvent({
    type: "mouseDown",
    button: mouseButton,
    clickCount: 1,
    ...point,
  });
  win.webContents.sendInputEvent({ type: "mouseUp", button: mouseButton, clickCount: 1, ...point });
}
const button = (text, scope = "document") =>
  evaluate(
    `Array.from(${scope}.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(text)}).click()`,
  );
async function input(selector, value) {
  await evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor((node.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement).prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function select(selector, value) {
  await evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await sleep(20);
}
async function terminalCommand(file, content) {
  await waitFor(
    "document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea')",
  );
  await evaluate(
    "document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea').focus()",
  );
  for (const character of JSON.stringify({ file, content }))
    win.webContents.sendInputEvent({ type: "char", keyCode: character });
  await key("Return");
}
async function capture(file) {
  win.show();
  win.focus();
  await sleep(100);
  await writeFile(join(output, file), (await win.webContents.capturePage()).toPNG());
}
async function state() {
  const value = await evaluate("window.kairo.bootstrap()");
  for (const item of value.terminals) pids.add(item.pid);
  return value;
}
async function nativeRecord(directory) {
  const records = [];
  for (const file of await readdir(process.env.KAIRO_FIXTURE_HISTORY)) {
    const record = JSON.parse(
      await readFile(join(process.env.KAIRO_FIXTURE_HISTORY, file), "utf8"),
    );
    if (record.cwd === directory) records.push(record);
  }
  const first = records.sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!first) throw new Error("Missing native fixture record");
  return first;
}

app.on("browser-window-created", (_, window) => {
  win = window;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") failures.push(event.message);
  });
  win.webContents.once(
    "did-finish-load",
    () =>
      void run().catch(async (error) => {
        console.error(error);
        await capture("failure.png").catch(() => {});
        console.error(
          await state()
            .then(({ sessions, terminals, activeSessionId }) => ({
              sessions,
              terminals,
              activeSessionId,
            }))
            .catch(() => ({})),
        );
        app.on("quit", () => process.exit(1));
        app.quit();
      }),
  );
});
async function run() {
  win.show();
  win.focus();
  await waitFor(
    "document.querySelector('.session-row.selected') && document.querySelector('.agent-workspace .xterm-helper-textarea')",
  );
  const startupMs = performance.now() - started;
  assert.equal(await evaluate("!!document.querySelector('.composer-wrap')"), false);
  if (process.env.KAIRO_SMOKE_RESTART === "1") {
    const saved = JSON.parse(await readFile(join(output, "saved.json"), "utf8")),
      value = await state();
    assert.equal(value.activeSessionId, saved.sessionId);
    assert.ok(
      await evaluate(
        `!!document.querySelector('.pinned-sessions [data-workspace-id="${saved.workspaceId}"]')`,
      ),
    );
    assert.equal(
      value.sessions.find((s) => s.id === saved.sessionId).nativeSession.id,
      saved.nativeId,
    );
    await waitFor(
      `window.kairo.attachTerminal(${JSON.stringify(value.terminals[0].id)}).then(t=>t.buffer.includes(${JSON.stringify(saved.nativeId)}))`,
    );
    const record = await nativeRecord(saved.directory);
    assert.equal(record.resumes, 2);
    assert.equal(record.prompts.length, 2);
    await writeFile(join(output, "restart-pids.json"), JSON.stringify([...pids]));
    await writeFile(
      join(output, "restart.json"),
      JSON.stringify({ startupMs, exactResume: true, workspaceId: saved.workspaceId }),
    );
    console.log("Terminal restart passed");
    app.quit();
    return;
  }
  let value = await state();
  const first = value.sessions.find((s) => s.id === process.env.KAIRO_SMOKE_FIRST),
    firstPty = value.terminals[0];
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(firstPty.id)}).then(t=>t.buffer.includes('CLI_READY'))`,
  );
  await terminalCommand("proof-a.txt", "Primary agent\n");
  await waitFor(
    `window.kairo.fileSnapshot(${JSON.stringify(first.id)},'proof-a.txt').then(s=>s.content==='Primary agent\\n').catch(()=>false)`,
  );
  assert.equal(
    await evaluate("!!document.querySelector('.agent-session-toolbar, .agent-session-notice')"),
    false,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.workspace-tools [aria-label=\"Browse files\"]')?.closest('aside')?.className",
    ),
    "workspace-tools",
  );
  await evaluate(`window.kairo.writeTerminal(${JSON.stringify(firstPty.id)}, "\\u001a")`);
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(firstPty.id)}).then(t=>/Stopped|suspended/i.test(t.buffer))`,
  );
  // Job-control output precedes the shell restoring its terminal modes/prompt.
  await sleep(500);
  await evaluate(
    `window.kairo.writeTerminal(${JSON.stringify(firstPty.id)}, ${JSON.stringify("printf 'SHELL_%s\\n' READY\r")})`,
  );
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(firstPty.id)}).then(t=>t.buffer.includes('SHELL_READY'))`,
  );
  await capture("normal-shell.png");
  await evaluate(`window.kairo.writeTerminal(${JSON.stringify(firstPty.id)}, "fg\\r")`);
  await sleep(100);
  await click('[aria-label="New terminal tab"]');
  await waitFor("window.kairo.listTerminals().then(all=>all.some(t=>!t.sessionId))");
  const shell = (await state()).terminals.find((t) => !t.sessionId);
  await waitFor(
    `document.querySelector('[aria-controls="terminal-view-${shell.id}"]')?.getAttribute('aria-selected')==='true'`,
  );
  await evaluate(
    `window.kairo.writeTerminal(${JSON.stringify(shell.id)}, ${JSON.stringify("printf 'TAB_%s\\n' READY\r")})`,
  );
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(shell.id)}).then(t=>t.buffer.includes('TAB_READY'))`,
  );
  await capture("terminal-tabs.png");
  // Jumping between shells in the same workspace must update the visible tab.
  await click('[aria-label="New terminal tab"]');
  await waitFor("window.kairo.listTerminals().then(all=>all.filter(t=>!t.sessionId).length===2)");
  const extraShell = (await state()).terminals.find((t) => !t.sessionId && t.id !== shell.id);
  await waitFor(
    `document.querySelector('[aria-controls="terminal-view-${extraShell.id}"]')?.getAttribute('aria-selected')==='true'`,
  );
  await key("j", ["meta"]);
  await waitFor("document.querySelector('#palette-title')");
  await input('[aria-label="Palette search"]', "Terminal 1");
  await waitFor("document.querySelector('.palette-results button')");
  await pointerClick(".palette-results button");
  await waitFor(
    `document.querySelector('[aria-controls="terminal-view-${shell.id}"]')?.getAttribute('aria-selected')==='true'`,
  );
  await evaluate(`window.kairo.closeTerminal(${JSON.stringify(extraShell.id)})`);
  await click(`[aria-controls="terminal-view-${firstPty.id}"]`);
  await waitFor(
    `document.querySelector('[aria-controls="terminal-view-${firstPty.id}"]')?.getAttribute('aria-selected')==='true'`,
  );
  await click('[aria-label="New agent tab"]');
  await waitFor(
    "document.querySelector('dialog[open] .primary') && !document.querySelector('dialog[open] .primary').disabled",
  );
  await input('[aria-label="Search agents"]', "");
  await waitFor("document.querySelectorAll('[role=option]').length===45");
  assert.equal(await evaluate("document.querySelectorAll('[role=option]').length"), 45);
  await input('[aria-label="Search agents"]', "Codex");
  await button("CodexInstalled · codex");
  // Adding an agent is scoped to the selected workspace; creation is separate.
  await button("Cancel", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  assert.equal(
    await evaluate(
      "!!document.querySelector('.session-row-actions, .project-setup-button, .project-menu-button')",
    ),
    false,
  );
  await pointerClick(".project-heading", "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Project setup", "document.querySelector('[role=menu]')");
  await waitFor("document.querySelector('[aria-label=\"Setup script\"]')");
  await input('[aria-label="Setup script"]', "echo PREPARING; sleep 1; touch setup-ready");
  await input('[aria-label="Copy paths"]', ".env");
  await button("Save project setup", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  await click(".new-chat");
  await waitFor("document.querySelector('[aria-label=\"Workspace mode\"]').value==='worktree'");
  await input('[aria-label="Workspace name"]', "Smoke isolated");
  await input('[aria-label="Branch override"]', "kairo/smoke-isolated");
  await select('[aria-label="Workspace agent"]', "codex");
  await button("Create workspace", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  await waitFor("document.querySelector('.preparation-panel')");
  await capture("workspace-preparation.png");
  // Navigation remains available during checkout and setup.
  await click(`[data-workspace-id="${first.workspaceId}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(first.workspaceId)}`,
  );
  await waitFor(
    "window.kairo.bootstrap().then(all=>all.operations.some(op=>op.name==='Smoke isolated'&&op.phase==='ready')&&all.sessions.length===2)",
  );
  value = await state();
  const second = value.sessions.find((s) => s.workspaceId !== first.workspaceId),
    owner = value.workspaces.find((w) => w.id === second.workspaceId);
  await waitFor(
    `window.kairo.bootstrap().then(all=>all.terminals.some(t=>t.sessionId===${JSON.stringify(second.id)}))`,
  );
  const pty = (await state()).terminals.find((t) => t.sessionId === second.id);
  await click(`[data-workspace-id="${owner.id}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(owner.id)}`,
  );
  assert.equal(await readFile(join(owner.directory, ".env"), "utf8"), "LOCAL_FIXTURE=1\n");
  assert.equal(await readFile(join(owner.directory, "setup-ready"), "utf8"), "");
  assert.equal(await evaluate("document.querySelectorAll('.terminal-tabs [role=tab]').length"), 1);
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal((await state()).terminals.length, 3);
  await assert.rejects(
    evaluate(`window.kairo.fileSnapshot(${JSON.stringify(second.id)},'proof-a.txt')`),
    /unavailable/,
  );
  await terminalCommand("proof-b.txt", "Isolated agent\n");
  await waitFor(
    `window.kairo.fileSnapshot(${JSON.stringify(second.id)},'proof-b.txt').then(s=>s.content==='Isolated agent\\n').catch(()=>false)`,
  );
  await button("Review");
  await waitFor(
    "Array.from(document.querySelectorAll('.changed-file-button')).some(b=>b.textContent.includes('proof-b.txt'))",
  );
  await waitFor("document.querySelector('.diff-scroll')?.textContent.includes('Isolated agent')");
  await capture("terminal-review-dark.png");
  await button("Open file");
  await waitFor("document.querySelector('[aria-label=\"Preview of proof-b.txt\"]')");
  await button("Edit");
  await input(".code-editor", "Edited in Kairo\n");
  await button("Save", "document.querySelector('.file-browser')");
  await waitFor("document.querySelector('.file-browser [role=status]')?.textContent==='Saved'");
  await click(`[data-workspace-id="${first.workspaceId}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(first.workspaceId)}`,
  );
  assert.equal((await state()).terminals.find((t) => t.sessionId === second.id).id, pty.id);
  await click(`[data-workspace-id="${second.workspaceId}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(second.workspaceId)}`,
  );
  await waitFor(
    `window.kairo.bootstrap().then(all=>!!all.sessions.find(s=>s.id===${JSON.stringify(second.id)})?.nativeSession)`,
  );
  const tuiTerminal = (await state()).terminals.find((t) => t.sessionId === second.id);
  await evaluate(`window.kairo.writeTerminal(${JSON.stringify(tuiTerminal.id)}, '__TUI__\\r')`);
  await waitFor(
    "document.querySelector('.terminal-view:not([hidden])')?.textContent.includes('ALTERNATE_SCREEN_FIXTURE')",
  );
  await evaluate(
    "window.__smokeTuiElement = document.querySelector('.terminal-view:not([hidden])')",
  );
  await click(`[data-workspace-id="${first.workspaceId}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(first.workspaceId)}`,
  );
  await click(`[data-workspace-id="${second.workspaceId}"] .session`);
  await waitFor(
    `document.querySelector('.workspace-row.selected')?.dataset.workspaceId===${JSON.stringify(second.workspaceId)}`,
  );
  await waitFor(
    "document.querySelector('.terminal-view:not([hidden])')?.textContent.includes('ALTERNATE_SCREEN_FIXTURE')",
  );
  assert.equal(
    await evaluate(
      "window.__smokeTuiElement === document.querySelector('.terminal-view:not([hidden])')",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.terminal-view[hidden] .xterm-accessibility').length",
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.terminal-view:not([hidden]) .xterm-accessibility').length",
    ),
    1,
  );
  await evaluate(`window.kairo.writeTerminal(${JSON.stringify(tuiTerminal.id)}, '__END_TUI__\\r')`);
  const beforeStop = await state();
  assert.equal(
    beforeStop.sessions.find((s) => s.id === second.id).nativeSession.id,
    (await nativeRecord(owner.directory)).id,
  );
  await click('[aria-label="New agent tab"]');
  await waitFor(
    "document.querySelector('dialog[open] .primary') && !document.querySelector('dialog[open] .primary').disabled",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[aria-label=\"Workspace mode\"]')"),
    false,
  );
  await button("Open agent terminal", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  const sharedState = await state(),
    shared = sharedState.sessions.find((s) => s.id === sharedState.activeSessionId);
  assert.equal(shared.workspaceId, second.workspaceId);
  assert.equal(shared.nativeSession, undefined);
  assert.equal(sharedState.workspaces.length, beforeStop.workspaces.length);
  assert.equal(
    sharedState.sessions.find((s) => s.id === second.id).nativeSession.id,
    beforeStop.sessions.find((s) => s.id === second.id).nativeSession.id,
  );
  await pointerClick(`.terminal-tabs [data-session-id="${shared.id}"]`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Archive agent tab", "document.querySelector('[role=menu]')");
  await waitFor(
    `window.kairo.bootstrap().then(all=>all.archivedSessions.some(s=>s.id===${JSON.stringify(shared.id)}))`,
  );
  await click(`.terminal-tabs [data-session-id="${second.id}"]`);
  await click(".settings-link");
  await button("Workspaces");
  await waitFor("document.querySelector('.terminal-catalog')");
  await evaluate(
    `Array.from(document.querySelectorAll('.terminal-catalog article')).find(row=>row.textContent.includes(${JSON.stringify(owner.directory)})).querySelector('button').click()`,
  );
  await waitFor(
    `window.kairo.listTerminals().then(all=>!all.some(t=>t.sessionId===${JSON.stringify(second.id)}))`,
  );
  await button("Back to workspace");
  const record = await nativeRecord(owner.directory);
  await evaluate(
    `window.kairo.setNativeSession(${JSON.stringify(second.id)},${JSON.stringify({ id: record.id })})`,
  );
  await button("Open agent terminal");
  await waitFor("window.kairo.listTerminals().then(all=>all.filter(t=>t.sessionId).length===2)");
  assert.notEqual((await state()).terminals.find((t) => t.sessionId === second.id).id, pty.id);
  await terminalCommand("proof-c.txt", "Resumed conversation\n");
  await waitFor(
    `window.kairo.fileSnapshot(${JSON.stringify(second.id)},'proof-c.txt').then(s=>s.content==='Resumed conversation\\n').catch(()=>false)`,
  );
  assert.equal((await nativeRecord(owner.directory)).resumes, 1);
  await pointerClick(`[data-workspace-id="${second.workspaceId}"] .session`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Pin", "document.querySelector('[role=menu]')");
  await waitFor(
    `document.querySelector('.pinned-sessions [data-workspace-id="${second.workspaceId}"]')`,
  );
  await pointerClick(`[data-workspace-id="${second.workspaceId}"] .session`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Unpin", "document.querySelector('[role=menu]')");
  await waitFor(
    `!document.querySelector('.pinned-sessions [data-workspace-id="${second.workspaceId}"]')`,
  );
  await pointerClick(`[data-workspace-id="${second.workspaceId}"] .session`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Pin", "document.querySelector('[role=menu]')");
  await waitFor(
    `document.querySelector('.pinned-sessions [data-workspace-id="${second.workspaceId}"]')`,
  );
  await pointerClick(`[data-workspace-id="${second.workspaceId}"] .session`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  await button("Rename", "document.querySelector('[role=menu]')");
  await waitFor("document.querySelector('[aria-label=\"Session name\"]')");
  await input('[aria-label="Session name"]', "Smoke isolated renamed");
  await button("Save name", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  await evaluate(
    `document.querySelector('[data-workspace-id="${second.workspaceId}"] .session').focus()`,
  );
  await key("F10", ["shift"]);
  await waitFor("document.querySelector('[role=menu]')");
  await key("End");
  assert.equal(await evaluate("document.activeElement?.textContent"), "Project setup");
  await key("Home");
  assert.equal(await evaluate("document.activeElement?.textContent"), "Rename");
  await key("Escape");
  await waitFor("!document.querySelector('[role=menu]')");
  // Keyboard palettes reuse workspace navigation and file editing.
  await key("j", ["meta"]);
  await waitFor("document.querySelector('#palette-title')");
  await input('[aria-label="Palette search"]', "Smoke isolated");
  await key("Return");
  await waitFor("!document.querySelector('dialog[open]')");
  await key("p", ["meta"]);
  await waitFor("document.querySelector('#palette-title')");
  await input('[aria-label="Palette search"]', "proof-b");
  await waitFor("document.querySelector('.palette-results button')");
  await capture("file-palette.png");
  await pointerClick(".palette-results button");
  await waitFor("!document.querySelector('dialog[open]')");
  await waitFor("document.querySelector('[aria-label=\"Preview of proof-b.txt\"]')");
  await pointerClick(`[data-workspace-id="${first.workspaceId}"] .session`, "right");
  await waitFor("document.querySelector('[role=menu]')");
  assert.equal((await state()).activeWorkspaceId, second.workspaceId);
  await capture("workspace-context-menu.png");
  await button("Archive", "document.querySelector('[role=menu]')");
  await button("Confirm", "document.querySelector('dialog')");
  await waitFor(
    `window.kairo.bootstrap().then(all=>all.workspaces.find(w=>w.id===${JSON.stringify(first.workspaceId)})?.archivedAt && !all.terminals.some(t=>t.workspaceId===${JSON.stringify(first.workspaceId)}))`,
  );
  assert.equal((await state()).sessions.find((s) => s.id === first.id).archivedAt, undefined);
  assert.ok(!(await state()).terminals.some((t) => t.id === shell.id));
  const savedOpenDialog = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [process.env.KAIRO_SMOKE_PROJECT],
    });
    await click(".open-project-button");
    await waitFor("document.querySelector('.welcome h1')?.textContent==='Workspace archived'");
    assert.equal(
      await evaluate(
        "Array.from(document.querySelectorAll('.terminal-tabs [role=tab]')).every(tab=>tab.disabled)",
      ),
      true,
    );
    await capture("archived-project-reopened.png");
    await button("Restore workspace", "document.querySelector('.welcome')");
    await waitFor(
      `window.kairo.bootstrap().then(all=>!all.workspaces.find(w=>w.id===${JSON.stringify(first.workspaceId)})?.archivedAt)`,
    );
    assert.equal(
      (await state()).terminals.filter((t) => t.workspaceId === first.workspaceId).length,
      0,
    );
    await evaluate(`window.kairo.archiveWorkspace(${JSON.stringify(first.workspaceId)})`);
  } finally {
    dialog.showOpenDialog = savedOpenDialog;
  }
  await click(".settings-link");
  await button("Archived");
  await waitFor(
    "document.querySelector('.settings-content')?.textContent.includes('Archived workspaces')",
  );
  await capture("pinned-and-archived.png");
  await button("Restore workspace", "document.querySelector('.settings-content')");
  await waitFor(
    `window.kairo.bootstrap().then(all=>!all.workspaces.find(w=>w.id===${JSON.stringify(first.workspaceId)})?.archivedAt)`,
  );
  assert.equal(
    (await state()).terminals.filter((t) => t.workspaceId === first.workspaceId).length,
    0,
  );
  await button("General");
  await select('[aria-label="Theme"]', "light");
  await button("Back to workspace");
  await capture("terminal-review-light.png");
  win.setSize(920, 700);
  await capture("terminal-narrow.png");
  await click(".new-chat");
  await waitFor("document.querySelector('[aria-label=\"Workspace project\"]')");
  await input('[aria-label="Workspace project"]', process.env.KAIRO_SMOKE_PLAIN);
  await input('[aria-label="Workspace name"]', "Plain folder");
  await waitFor(
    "document.querySelector('[aria-label=\"Workspace mode\"]')?.value==='folder' && !document.querySelector('[aria-label=\"Starting ref\"]')",
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Workspace mode\"]').options.length"),
    1,
  );
  await capture("plain-folder-creation.png");
  await button("Create workspace", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  assert.equal((await state()).workspaces.find((w) => w.name === "Plain folder").kind, "folder");
  await click(`[data-workspace-id="${second.workspaceId}"] .session`);
  await waitFor(
    `window.kairo.bootstrap().then(all=>all.activeSessionId===${JSON.stringify(second.id)})`,
  );
  await writeFile(
    join(output, "saved.json"),
    JSON.stringify({
      sessionId: second.id,
      workspaceId: second.workspaceId,
      directory: owner.directory,
      nativeId: record.id,
    }),
  );
  await writeFile(join(output, "terminal-pids.json"), JSON.stringify([...pids]));
  await writeFile(
    join(output, "metrics.json"),
    JSON.stringify({
      startupMs,
      workspaceFirst: true,
      backgroundPreparation: true,
      independentCopies: true,
      terminalTabs: true,
      palettes: true,
      pinUnpinAndPersistence: true,
      archiveWorkspaceAndRestore: true,
      archivedProjectRestoreWithoutLaunch: true,
      plainFolderCreation: true,
      sameTerminalShellJobControl: true,
      alternateScreenPreservedAcrossSwitching: true,
      accessibilityOnlyOnActiveTerminal: true,
      isolatedWorktree: true,
      parallelNavigation: true,
      review: true,
      editing: true,
      exactNativeResume: true,
    }),
  );
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("Workspace desktop smoke passed");
  app.quit();
}
void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
