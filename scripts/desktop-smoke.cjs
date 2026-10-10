const { app } = require("electron");
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
const button = (text, scope = "document") =>
  evaluate(
    `Array.from(${scope}.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(text)}).click()`,
  );
async function input(selector, value) {
  await evaluate(
    `(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${selector.includes("code-editor") ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`,
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
  for (const file of await readdir(process.env.KAIRO_FIXTURE_HISTORY)) {
    const record = JSON.parse(
      await readFile(join(process.env.KAIRO_FIXTURE_HISTORY, file), "utf8"),
    );
    if (record.cwd === directory) return record;
  }
  throw new Error("Missing native fixture record");
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
  await click(".new-chat");
  await waitFor(
    "document.querySelector('dialog[open]') && !Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Refresh agents')?.disabled",
  );
  assert.equal(await evaluate("document.querySelectorAll('[role=option]').length"), 45);
  await input('[aria-label="Search agents"]', "Codex");
  await button("CodexInstalled · codex");
  await waitFor("document.querySelector('[aria-label=\"Workspace mode\"] option[value=worktree]')");
  await select('[aria-label="Workspace mode"]', "worktree");
  await input('[aria-label="Branch"]', "kairo/smoke-isolated");
  await button("Open agent terminal", "document.querySelector('dialog')");
  await waitFor("!document.querySelector('dialog[open]')");
  value = await state();
  const second = value.sessions.find((s) => s.id === value.activeSessionId),
    owner = value.workspaces.find((w) => w.id === second.workspaceId),
    pty = value.terminals.find((t) => t.sessionId === second.id);
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal(value.terminals.length, 2);
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
  await click(`[data-session-id="${first.id}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected')?.dataset.sessionId===${JSON.stringify(first.id)}`,
  );
  value = await state();
  assert.equal(value.terminals.find((t) => t.sessionId === second.id).id, pty.id);
  await click(`[data-session-id="${second.id}"] .session`);
  await waitFor(
    `document.querySelector('.session-row.selected')?.dataset.sessionId===${JSON.stringify(second.id)}`,
  );
  await waitFor(
    `window.kairo.bootstrap().then(all=>!!all.sessions.find(s=>s.id===${JSON.stringify(second.id)})?.nativeSession)`,
  );
  const beforeStop = await state();
  assert.equal(
    beforeStop.sessions.find((s) => s.id === second.id).nativeSession.id,
    (await nativeRecord(owner.directory)).id,
  );
  await click(".settings-link");
  await button("Workspaces");
  await waitFor("document.querySelector('.terminal-catalog')");
  await evaluate(
    `Array.from(document.querySelectorAll('.terminal-catalog article')).find(row => row.textContent.includes(${JSON.stringify(owner.directory)})).querySelector('button').click()`,
  );
  await waitFor(
    `window.kairo.listTerminals().then(all=>!all.some(t=>t.sessionId===${JSON.stringify(second.id)}))`,
  );
  await button("Back to workspace");
  const record = await nativeRecord(owner.directory);
  await evaluate(
    `window.kairo.setNativeSession(${JSON.stringify(second.id)}, ${JSON.stringify({ id: record.id })})`,
  );
  await button("Open agent terminal");
  await waitFor("window.kairo.listTerminals().then(all=>all.filter(t=>t.sessionId).length===2)");
  value = await state();
  assert.notEqual(value.terminals.find((t) => t.sessionId === second.id).id, pty.id);
  await terminalCommand("proof-c.txt", "Resumed conversation\n");
  await waitFor(
    `window.kairo.fileSnapshot(${JSON.stringify(second.id)},'proof-c.txt').then(s=>s.content==='Resumed conversation\\n').catch(()=>false)`,
  );
  assert.equal((await nativeRecord(owner.directory)).resumes, 1);
  await click(".settings-link");
  await select('[aria-label="Theme"]', "light");
  await button("Back to workspace");
  await capture("terminal-review-light.png");
  win.setSize(920, 700);
  await capture("terminal-narrow.png");
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
      embeddedAgentInput: true,
      sameTerminalShellJobControl: true,
      isolatedWorktree: true,
      parallelNavigation: true,
      review: true,
      editing: true,
      exactNativeResume: true,
    }),
  );
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log("Terminal desktop smoke passed");
  app.quit();
}
void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
