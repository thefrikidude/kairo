const { app, BrowserWindow, dialog } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const started = performance.now();
app.setPath("userData", join(process.env.KAIRO_STATE_DIR, "electron"));
let win;
const failures = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function evaluate(code) {
  try {
    return await win.webContents.executeJavaScript(code);
  } catch (error) {
    console.error("Failed UI expression:", code, failures);
    throw error;
  }
}
async function waitFor(code) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await evaluate(code)) return;
    await sleep(30);
  }
  throw new Error(`UI timed out: ${code}`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await sleep(20);
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function capture(name) {
  win.show();
  win.focus();
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
  await sleep(100);
  const image = await win.webContents.capturePage();
  await writeFile(join(process.env.KAIRO_SMOKE_OUTPUT, name), image.toPNG());
}
async function editBuffer(content) {
  await evaluate(
    `(() => { const node = document.querySelector('.code-editor'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(content)}); node.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
}
app.on("browser-window-created", (_event, window) => {
  win = window;
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") failures.push(event.message);
  });
  window.webContents.once("did-finish-load", () => {
    void run().catch(async (error) => {
      console.error(error);
      await capture("failure.png").catch(() => {});
      console.error(
        "Terminal diagnostics:",
        await evaluate("window.kairo.listTerminals()").catch(() => []),
      );
      app.on("quit", () => process.exit(1));
      app.quit();
    });
  });
});
async function run() {
  await waitFor("document.querySelector('.session[aria-current=page]')");
  const startupMs = performance.now() - started;
  if (process.env.KAIRO_SMOKE_RESTART === "1") {
    const saved = await evaluate("window.kairo.bootstrap()");
    assert.deepEqual(await evaluate("window.kairo.listTerminals()"), []);
    assert.ok(saved.sessions.some((session) => session.title === "Renamed task"));
    const workspace = saved.workspaces.find((item) => item.managed && !item.removedAt);
    assert.ok(workspace?.baseCommit);
    const session = saved.sessions.find((item) => item.workspaceId === workspace.id);
    assert.ok(session);
    assert.equal(session.workspace, workspace.directory);
    if (saved.activeSessionId !== session.id)
      await click(`[data-session-id="${session.id}"] .session`);
    await waitFor(
      `document.querySelector('.session-row.selected').dataset.sessionId === ${JSON.stringify(session.id)}`,
    );
    const text = await evaluate(
      `window.kairo.readFile(${JSON.stringify(session.id)}, 'src/hello.ts')`,
    );
    assert.match(text, /External change/);
    assert.equal(await evaluate("document.querySelector('#workspace-panel').hidden"), true);
    await writeFile(
      join(process.env.KAIRO_SMOKE_OUTPUT, "restart.json"),
      JSON.stringify({
        startupMs: Math.round(startupMs),
        restoredWorkspaceId: workspace.id,
        restoredSessionId: session.id,
      }),
    );
    console.log("Desktop restart smoke passed");
    app.quit();
    return;
  }
  assert.equal(await evaluate("document.querySelector('#workspace-panel').hidden"), true);
  assert.equal(await evaluate("!!document.querySelector('.status-complete')"), true);
  await click(".session-row.selected .session-action-button[title='Rename session']");
  await waitFor("document.querySelector('#rename-session-title')");
  await waitFor(
    "document.activeElement === document.querySelector('[aria-labelledby=rename-session-title] input')",
  );
  for (let index = 0; index < 6; index += 1) {
    await key("Tab");
    assert.equal(await evaluate("!!document.activeElement.closest('dialog[open]')"), true);
  }
  await key("Tab", ["shift"]);
  assert.equal(await evaluate("document.activeElement.getAttribute('type')"), "submit");
  await evaluate(`(() => {
    const input = document.querySelector('[aria-labelledby=rename-session-title] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Renamed task');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click("[aria-labelledby=rename-session-title] button[type=submit]");
  await waitFor(
    "document.querySelector('.session-row.selected .session-title')?.textContent === 'Renamed task'",
  );
  const current = await evaluate("window.kairo.bootstrap()");
  assert.equal(
    current.sessions.find((s) => s.id === current.activeSessionId).title,
    "Renamed task",
  );
  await evaluate("document.querySelector('.new-chat').focus()");
  await click(".new-chat");
  await waitFor("document.querySelector('#new-session-title')");
  for (let index = 0; index < 12; index += 1) {
    await key("Tab");
    assert.equal(await evaluate("!!document.activeElement.closest('dialog[open]')"), true);
  }
  await key("Escape");
  await waitFor("!document.querySelector('#new-session-title')");
  assert.equal(
    await evaluate("document.activeElement === document.querySelector('.new-chat')"),
    true,
  );
  await click(".new-chat");
  await waitFor("document.querySelector('#new-session-title')");
  assert.equal(
    await evaluate("document.querySelector('.session-folder-picker small').textContent"),
    process.env.KAIRO_SMOKE_PROJECT,
  );
  await waitFor("!document.querySelector('.session-picker-dialog button.primary').disabled");
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Task workspace\"]').value"),
    "worktree",
  );
  await click(".session-picker-dialog button.primary");
  await waitFor("!document.querySelector('#new-session-title')");
  const isolated = await evaluate("window.kairo.bootstrap()");
  const isolatedSession = isolated.sessions.find((s) => s.id === isolated.activeSessionId);
  const isolatedWorkspace = isolated.workspaces.find((w) => w.id === isolatedSession.workspaceId);
  assert.equal(isolatedWorkspace.managed, true);
  assert.equal(isolatedWorkspace.kind, "worktree");
  assert.equal(isolatedWorkspace.repositoryPath, process.env.KAIRO_SMOKE_PROJECT);
  assert.notEqual(isolatedWorkspace.directory, process.env.KAIRO_SMOKE_PROJECT);
  await click(".top-actions button[title^='Browse files']");
  await waitFor("document.querySelector('.file-entry')");
  if (process.env.KAIRO_SMOKE_LARGE === "1")
    assert.ok(await evaluate("document.querySelectorAll('.file-entry').length < 100"));
  await evaluate(
    "Array.from(document.querySelectorAll('.file-entry')).find(e => e.textContent.includes('src')).click()",
  );
  await waitFor("document.querySelector('[data-file-path=\"src/hello.ts\"]')");
  await click('[data-file-path="src/hello.ts"]');
  await waitFor(
    "document.querySelector('.file-preview')?.textContent.includes('Hello from the workspace')",
  );
  await click("button[aria-label='Reload file preview']");
  await waitFor(
    "document.querySelector('.file-preview')?.textContent.includes('Hello from the workspace')",
  );
  await click(".file-editor-actions button");
  await waitFor("document.querySelector('.code-editor')");
  await editBuffer('export const message = "Edited in Kairo";\n');
  await waitFor(
    "document.querySelector('.file-editor-actions').textContent.includes('Unsaved changes')",
  );
  await click(`[data-session-id="${process.env.KAIRO_SMOKE_FIRST}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected').dataset.sessionId === ${JSON.stringify(process.env.KAIRO_SMOKE_FIRST)}`,
  );
  await click(`[data-session-id="${isolatedSession.id}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected').dataset.sessionId === ${JSON.stringify(isolatedSession.id)}`,
  );
  await waitFor("document.querySelector('.unsaved-files button')");
  await click(".unsaved-files button");
  await waitFor("document.querySelector('.code-editor')?.value.includes('Edited in Kairo')");
  await click("#changes-tab");
  await click("#files-tab");
  await waitFor("document.querySelector('.unsaved-files button')");
  await click(".unsaved-files button");
  await waitFor("document.querySelector('.code-editor')?.value.includes('Edited in Kairo')");
  const nativePrompt = dialog.showMessageBoxSync;
  dialog.showMessageBoxSync = () => 0;
  app.quit();
  await sleep(100);
  assert.ok((await evaluate("window.kairo.bootstrap()")).sessions.length > 0);
  dialog.showMessageBoxSync = nativePrompt;
  await click(".file-editor-actions button.primary");
  await waitFor(
    "!document.querySelector('.file-editor-actions').textContent.includes('Unsaved changes')",
  );
  const source = await evaluate(
    `window.kairo.readFile(${JSON.stringify(process.env.KAIRO_SMOKE_FIRST)}, 'src/hello.ts')`,
  );
  assert.match(source, /Hello from the workspace/);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: isolatedWorkspace.directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["add", "src/hello.ts"]);
  git([
    "-c",
    "user.name=Kairo smoke",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Reviewed fixture edit",
  ]);
  await click("#changes-tab");
  await click("button[aria-label='Refresh changed files']");
  await waitFor("document.querySelector('.diff-add')?.textContent.includes('Edited in Kairo')");
  for (let step = 0; step < 15; step += 1)
    await evaluate(
      "document.querySelector('[aria-label=\"Resize workspace panel\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))",
    );
  await evaluate(
    "Array.from(document.querySelectorAll('.selected-diff-toolbar button')).find(e => e.textContent === 'Split').click()",
  );
  await waitFor("document.querySelector('.split-diff')");
  await sleep(100);
  await capture("split-review.png");
  await evaluate(
    `(() => { const node = document.querySelector('[aria-label="Review scope"]'); node.value = 'working'; node.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await waitFor(
    "document.querySelector('.review-panel')?.textContent.includes('Working tree is clean')",
  );
  await evaluate(
    `(() => { const node = document.querySelector('[aria-label="Review scope"]'); node.value = 'task'; node.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await waitFor("document.querySelector('.changed-file-button')");
  await click("#files-tab");
  await waitFor("document.querySelector('.file-entry')");
  await click('[data-file-path="src"]');
  await waitFor("document.querySelector('[data-file-path=\"src/hello.ts\"]')");
  await click('[data-file-path="src/hello.ts"]');
  await waitFor("document.querySelector('.file-preview')?.textContent.includes('Edited in Kairo')");
  await click(".file-editor-actions button");
  await waitFor("document.querySelector('.code-editor')");
  await editBuffer("My unsaved draft\n");
  await evaluate(
    `(async () => { const snapshot = await window.kairo.fileSnapshot(${JSON.stringify(isolatedSession.id)}, 'src/hello.ts'); await window.kairo.saveFile(${JSON.stringify(isolatedSession.id)}, 'src/hello.ts', ${JSON.stringify('export const message = "External change";\n')}, snapshot.revision); })()`,
  );
  await click(".file-editor-actions button.primary");
  await waitFor("document.querySelector('.file-error')?.textContent.includes('changed outside')");
  assert.match(await evaluate("document.querySelector('.code-editor').value"), /My unsaved draft/);
  await click("button[aria-label='Reload file preview']");
  await waitFor("document.querySelector('.inline-confirm')");
  await evaluate(
    "Array.from(document.querySelectorAll('.inline-confirm button')).find(e => e.textContent === 'Discard and reload').click()",
  );
  await waitFor("document.querySelector('.file-preview')?.textContent.includes('External change')");
  await sleep(100);
  await capture("file-preview.png");
  if (process.env.KAIRO_SMOKE_LARGE === "1") {
    await evaluate(
      `(async () => { const snapshot = await window.kairo.fileSnapshot(${JSON.stringify(isolatedSession.id)}, 'src/large.ts'); await window.kairo.saveFile(${JSON.stringify(isolatedSession.id)}, 'src/large.ts', snapshot.content.replaceAll('export const value', 'export const revised'), snapshot.revision); })()`,
    );
    await click("#changes-tab");
    await click("button[aria-label='Refresh changed files']");
    await waitFor(
      "Array.from(document.querySelectorAll('.changed-file-button')).some(e => e.textContent.includes('src/large.ts'))",
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.changed-file-button')).find(e => e.textContent.includes('src/large.ts')).click()",
    );
    await waitFor("document.querySelector('.diff-remove')?.textContent.includes('value0')");
    assert.ok(await evaluate("document.querySelectorAll('.diff-row').length < 100"));
    await evaluate(
      "document.querySelector('.virtual-rows.diff-scroll').scrollTop = document.querySelector('.virtual-rows.diff-scroll').scrollHeight",
    );
    await waitFor(
      "Array.from(document.querySelectorAll('.diff-add')).some(e => e.textContent.includes('revised9999'))",
    );
    await capture("large-diff.png");
    await click("#files-tab");
    await waitFor("document.querySelector('.file-entry')");
  }
  const panelWidth = await evaluate(
    "Number(document.querySelector('[aria-label=\"Resize workspace panel\"]').getAttribute('aria-valuenow'))",
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Resize workspace panel\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))",
  );
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[aria-label=\"Resize workspace panel\"]').getAttribute('aria-valuenow'))",
    ),
    Math.min(720, panelWidth + 20),
  );
  const switchStart = performance.now();
  const targetId = process.env.KAIRO_SMOKE_FIRST;
  const targetTitle = current.sessions.find((session) => session.id === targetId).title;
  await click(`[data-session-id="${targetId}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected .session-title')?.textContent === ${JSON.stringify(targetTitle)}`,
  );
  const switchMs = performance.now() - switchStart;
  await waitFor("document.querySelector('.file-entry')");
  assert.equal(await evaluate("!!document.querySelector('.file-preview')"), false);
  await evaluate("document.querySelector('#files-tab').focus()");
  await key("Right");
  assert.equal(await evaluate("document.activeElement.id"), "changes-tab");
  await key("Home");
  assert.equal(await evaluate("document.activeElement.id"), "files-tab");
  await key("End");
  assert.equal(await evaluate("document.activeElement.id"), "changes-tab");
  await click("#changes-tab");
  await waitFor("document.querySelector('#changes-tab').getAttribute('aria-selected') === 'true'");
  await sleep(100);
  await capture("desktop-wide.png");
  win.setSize(900, 700);
  await sleep(150);
  const footer = await evaluate(
    "(() => { const e = document.querySelector('.agent-usage-footer'); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; })()",
  );
  assert.ok(footer && footer.bottom <= footer.height && footer.top >= 0);
  await capture("desktop-narrow.png");
  await click("button[aria-label='Close review']");
  await click(".settings-link");
  await waitFor("document.querySelector('.theme-options')");
  await evaluate(
    "Array.from(document.querySelectorAll('.theme-options button')).find(e => e.textContent === 'Light').click()",
  );
  await click(".settings-back");
  await waitFor("document.querySelector('.app-shell')?.dataset.theme === 'light'");
  await sleep(150);
  await capture("desktop-light.png");
  // Exercise the lazy native terminal through the real renderer/preload/backend bridge.
  assert.equal(await evaluate("!!document.querySelector('.terminal-panel')"), false);
  await click("button[aria-label='Toggle terminal']");
  await waitFor("document.querySelector('.terminal-panel:not([hidden]) .xterm-helper-textarea')");
  const rootTerminal = (await evaluate("window.kairo.listTerminals()"))[0];
  assert.equal(rootTerminal.directory, process.env.KAIRO_SMOKE_PROJECT);
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(rootTerminal.id)}).then(value => value.buffer.length > 0)`,
  );
  await sleep(300);
  await evaluate(
    "document.querySelector('.terminal-panel:not([hidden]) .terminal-view:not([hidden]) .xterm-helper-textarea').focus()",
  );
  for (const character of "printf '\\033[32mTERMINAL_INPUT_OK\\033[0m\\n'; pwd")
    win.webContents.sendInputEvent({ type: "char", keyCode: character });
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await waitFor(
    `window.kairo.attachTerminal(${JSON.stringify(rootTerminal.id)}).then(value => value.buffer.includes("\\u001b[32mTERMINAL_INPUT_OK\\u001b[0m"))`,
  );
  const rootSnapshot = await evaluate(
    `window.kairo.attachTerminal(${JSON.stringify(rootTerminal.id)})`,
  );
  assert.ok(rootSnapshot.buffer.includes("\x1b[32mTERMINAL_INPUT_OK\x1b[0m"));
  assert.ok(rootSnapshot.buffer.includes(process.env.KAIRO_SMOKE_PROJECT));
  await sleep(100);
  await capture("terminal-input.png");
  await click("button[aria-label='Hide terminal']");
  assert.equal(await evaluate("document.querySelector('.terminal-panel').hidden"), true);
  await click("button[aria-label='Toggle terminal']");
  await waitFor("document.querySelector('.terminal-panel:not([hidden])')");
  assert.equal((await evaluate("window.kairo.listTerminals()"))[0].id, rootTerminal.id);
  await click("button[aria-label='New terminal']");
  await waitFor("document.querySelectorAll('.terminal-tab').length === 2");
  await evaluate("document.querySelector('.terminal-tabs [role=tab][aria-selected=true]').focus()");
  await key("Left");
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelectorAll('.terminal-tabs [role=tab]')[0]",
    ),
    true,
  );
  await key("End");
  assert.equal(
    await evaluate(
      "document.activeElement === document.querySelectorAll('.terminal-tabs [role=tab]')[1]",
    ),
    true,
  );
  const heightBefore = await evaluate(
    "Number(document.querySelector('[aria-label=\"Resize terminal\"]').getAttribute('aria-valuenow'))",
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Resize terminal\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))",
  );
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[aria-label=\"Resize terminal\"]').getAttribute('aria-valuenow'))",
    ),
    heightBefore + 20,
  );
  await capture("terminal-light.png");
  await click(`[data-session-id="${isolatedSession.id}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected').dataset.sessionId === ${JSON.stringify(isolatedSession.id)}`,
  );
  assert.equal(await evaluate("document.querySelector('.terminal-panel').hidden"), true);
  await click("button[aria-label='Toggle terminal']");
  await waitFor("document.querySelector('.terminal-panel:not([hidden]) .terminal-tab')");
  const terminals = await evaluate("window.kairo.listTerminals()");
  assert.equal(terminals.length, 3);
  assert.ok(
    terminals.some(
      (item) =>
        item.workspaceId === isolatedWorkspace.id && item.directory === isolatedWorkspace.directory,
    ),
  );
  const terminalFooter = await evaluate(
    "(() => { const r = document.querySelector('.agent-usage-footer').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; })()",
  );
  assert.ok(terminalFooter.top >= 0 && terminalFooter.bottom <= terminalFooter.height);
  await capture("terminal-worktree.png");
  await click("button[aria-label='Close terminal 1']");
  await waitFor("document.querySelectorAll('.terminal-tab').length === 0");
  await writeFile(
    join(process.env.KAIRO_SMOKE_OUTPUT, "terminal-pids.json"),
    JSON.stringify(terminals.map((item) => item.pid)),
  );
  await click(".settings-link");
  await evaluate(
    "Array.from(document.querySelectorAll('.settings-nav')).find(item => item.textContent === 'Workspaces').click()",
  );
  await waitFor(
    "document.querySelectorAll('.terminal-catalog .workspace-catalog-row').length === 2",
  );
  await click(".terminal-catalog .workspace-catalog-row button");
  await waitFor(
    "document.querySelectorAll('.terminal-catalog .workspace-catalog-row').length === 1",
  );
  await capture("terminal-catalog.png");
  const beforeHistory = await evaluate("window.kairo.bootstrap()");
  await evaluate(
    "Array.from(document.querySelectorAll('.settings-nav')).find(item => item.textContent.startsWith('Archived chats')).click()",
  );
  await waitFor("document.querySelector('.archived-row')");
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('.archived-actions button')).find(item => item.textContent === 'Restore').disabled",
    ),
    true,
  );
  await click("button[aria-label='View Archived removed worktree']");
  await waitFor(
    "document.querySelector('.history-messages')?.textContent.includes('Saved history remains available')",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.history-notice').textContent.includes('Worktree removed')",
    ),
  );
  assert.equal(await evaluate("!!document.querySelector('.composer')"), false);
  await click(".history-task > summary");
  await waitFor("document.querySelector('.history-task').textContent.includes('1 test passed')");
  assert.equal(
    (await evaluate("window.kairo.bootstrap()")).activeSessionId,
    beforeHistory.activeSessionId,
  );
  await capture("archived-history.png");
  await click(".history-back");
  await waitFor("document.querySelector('.archived-row')");
  assert.deepEqual(failures, []);
  const metrics = {
    startupMs: Math.round(startupMs),
    switchMs: Math.round(switchMs),
    processes: app
      .getAppMetrics()
      .map(({ type, memory }) => ({ type, workingSetKB: memory?.workingSetSize })),
  };
  await writeFile(
    join(process.env.KAIRO_SMOKE_OUTPUT, "metrics.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log("Desktop smoke passed:", JSON.stringify(metrics));
  app.quit();
}
void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
