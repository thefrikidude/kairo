const { app } = require("electron"),
  assert = require("node:assert/strict");
const { writeFile, readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.env.KAIRO_NATIVE_OUTPUT,
  pids = new Set(),
  expected = { codex: "Kairo Codex native proof\n", opencode: "Kairo OpenCode native proof\n" };
app.setPath("userData", join(process.env.KAIRO_STATE_DIR, "electron"));
let win;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  evaluate = (code) => win.webContents.executeJavaScript(code);
async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Installed-agent workflow timed out");
    await sleep(100);
  }
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button = (text, scope = "document") =>
  evaluate(
    `Array.from(${scope}.querySelectorAll('button')).find(node=>node.textContent.trim()===${JSON.stringify(text)}).click()`,
  );
async function input(selector, value) {
  await evaluate(
    `(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", modifiers: [], keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", modifiers: [], keyCode });
  await sleep(50);
}
async function state() {
  const value = await evaluate("window.kairo.bootstrap()");
  for (const item of value.terminals) pids.add(item.pid);
  return value;
}
const screen = () =>
  evaluate(
    "Array.from(document.querySelectorAll('.agent-workspace .terminal-view:not([hidden]) .xterm-accessibility div')).map(n=>n.textContent).join('\\n').replace(/\\u00a0/g,' ')",
  );
async function capture(file) {
  await writeFile(join(output, file), (await win.webContents.capturePage()).toPNG());
}
async function focus() {
  app.focus({ steal: true });
  win.focus();
  win.webContents.focus();
  await until(() =>
    evaluate(
      "!!document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea')",
    ),
  );
  await evaluate(
    "document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea').focus()",
  );
}
async function type(text) {
  await focus();
  // Use the same DOM paste path as xterm's clipboard handling, without changing the user's clipboard.
  await evaluate(
    `(()=>{const node=document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea');const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`,
  );
  await sleep(800);
  await key("Return");
  await sleep(500);
  if (/trust.*(folder|directory)|trust this|trust and continue/i.test(await screen())) {
    await key("Return");
    await sleep(800);
    const displayed = await screen();
    if (/Ask Codex to do anything/.test(displayed) && !displayed.includes(text.slice(0, 25))) {
      await evaluate(
        `(()=>{const n=document.querySelector('.agent-workspace .terminal-view:not([hidden]) .xterm-helper-textarea');const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});n.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`,
      );
      await sleep(800);
      await key("Return");
    }
  }
}

async function ready(id) {
  await focus();
  for (let count = 0; count < 50; count++) {
    const text = await screen();
    if (
      /trust.*(folder|directory)|trust this|trust and continue|yes,.*(continue|proceed)/i.test(text)
    ) {
      await key("Return");
      await sleep(700);
      continue;
    }
    if (
      (id === "codex" && /›|Ask|Try "/i.test(text)) ||
      (id === "opencode" && /\b(build|plan)\b|ctrl.*p.*command/i.test(text))
    ) {
      await sleep(600);
      return;
    }
    await sleep(200);
  }
  throw new Error(`${id} native terminal did not become ready`);
}
async function create(id) {
  await click(".new-chat");
  await until(() =>
    evaluate(
      "!!document.querySelector('dialog[open]') && Array.from(document.querySelectorAll('dialog button')).some(b=>b.textContent==='Refresh agents'&&!b.disabled)",
    ),
  );
  await input('[aria-label="Search agents"]', id);
  await evaluate(
    `Array.from(document.querySelectorAll('[role=option]')).find(n=>n.querySelector('strong').textContent===${JSON.stringify(id === "codex" ? "Codex" : "OpenCode")}).click()`,
  );
  await until(() =>
    evaluate("!!document.querySelector('[aria-label=\"Workspace mode\"] option[value=worktree]')"),
  );
  await input('[aria-label="Branch"]', `kairo/native-${id}`);
  await button("Open agent terminal", "document.querySelector('dialog')");
  await until(() => evaluate("!document.querySelector('dialog[open]')"));
  const value = await state(),
    session = value.sessions.find((item) => item.id === value.activeSessionId),
    workspace = value.workspaces.find((item) => item.id === session.workspaceId);
  await ready(id);
  console.log(`${id}: terminal ready`);
  await capture(`${id}-ready.png`);
  return {
    sessionId: session.id,
    workspaceId: workspace.id,
    directory: workspace.directory,
    agentId: id,
  };
}
async function approveFixtureCommand(file) {
  const text = await screen();
  if (
    /would you like|permission|approve/i.test(text) &&
    text.includes("node") &&
    text.includes(file)
  ) {
    await focus();
    await key("Return");
  }
}
async function proof(record, file, content) {
  await type(
    `Create ${file} containing exactly ${JSON.stringify(content)}. Run a Node command to verify its exact contents. Do not commit or modify any other files. Reply READY when done.`,
  );
  if (record.agentId === "codex") {
    for (let n = 0; n < 12; n++) {
      await sleep(250);
      const text = await screen();
      if (/trust and continue|trust.*(folder|directory)/i.test(text)) {
        await key("Return");
        await sleep(900);
        if (/Ask Codex to do anything/.test(await screen())) {
          await type(
            `Create ${file} containing exactly ${JSON.stringify(content)}. Run a Node command to verify its contents. Do not modify other files. Reply READY.`,
          );
        }
        break;
      }
    }
  }
  console.log(`${record.agentId}: prompt submitted`);
  await capture(`${record.agentId}-submitted.png`);
}
async function waitProof(record, file, content) {
  await until(async () => {
    await approveFixtureCommand(file);
    return await readFile(join(record.directory, file), "utf8")
      .then((value) => value === content)
      .catch(() => false);
  }, 120000);
  console.log(`${record.agentId}: native proof file saved`);
  await until(async () => {
    const value = await state();
    const session = value.sessions.find((item) => item.id === record.sessionId);
    if (!session.nativeSession) return false;
    record.nativeId = session.nativeSession.id;
    return true;
  });
}
async function open(record) {
  await click(`[data-session-id="${record.sessionId}"] .session`);
  await until(() =>
    evaluate(
      `document.querySelector('.session-row.selected')?.dataset.sessionId===${JSON.stringify(record.sessionId)}`,
    ),
  );
  await ready(record.agentId);
}
app.on("browser-window-created", (_, window) => {
  win = window;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once(
    "did-finish-load",
    () =>
      void run().catch(async (error) => {
        console.error(error.message);
        await capture("failure.png").catch(() => {});
        const value = await state().catch(() => ({
          sessions: [],
          terminals: [],
          sessionErrors: {},
        }));
        const diagnostics = [];
        for (const terminal of value.terminals)
          diagnostics.push(
            await evaluate(`window.kairo.attachTerminal(${JSON.stringify(terminal.id)})`).catch(
              () => ({ id: terminal.id }),
            ),
          );
        await writeFile(join(output, "terminal-diagnostics.json"), JSON.stringify(diagnostics));
        console.error(
          JSON.stringify({
            sessionErrors: value.sessionErrors,
            terminals: value.terminals.map((t) => ({
              id: t.id,
              state: t.state,
              exitCode: t.exitCode,
            })),
          }),
        );
        app.on("quit", () => process.exit(1));
        app.quit();
      }),
  );
});
// Let Kairo drain its backend and PTYs when the parent smoke watchdog times out.
process.on("SIGTERM", () => {
  app.once("quit", () => process.exit(1));
  app.quit();
});

async function run() {
  win.show();
  win.focus();
  await until(() => evaluate("!!document.querySelector('.new-chat')"));
  await state();
  if (process.env.KAIRO_NATIVE_RESTART === "1") {
    const saved = JSON.parse(await readFile(join(output, "workflow.json"), "utf8"));
    for (const record of [saved.opencode, saved.codex]) {
      const expectedNativeId = record.nativeId;
      await open(record);
      const before = await state();
      assert.equal(
        before.sessions.find((item) => item.id === record.sessionId).nativeSession.id,
        record.nativeId,
      );
      const file = `${record.agentId}-resume.txt`,
        content = `Resumed ${record.agentId}\n`;
      await proof(record, file, content);
      await waitProof(record, file, content);
      assert.equal(record.nativeId, expectedNativeId);
      await capture(`${record.agentId}-resumed.png`);
    }
    await writeFile(join(output, "restart-pids.json"), JSON.stringify([...pids]));
    await writeFile(
      join(output, "restart.json"),
      JSON.stringify({
        exactResume: true,
        workspacesPreserved: true,
        codex: saved.codex.nativeId,
        opencode: saved.opencode.nativeId,
      }),
    );
    console.log("Installed native restart proved");
    app.quit();
    return;
  }
  const codex = await create("codex");
  await proof(codex, "codex-proof.txt", expected.codex);
  const opencode = await create("opencode");
  await proof(opencode, "opencode-proof.txt", expected.opencode);
  const value = await state();
  assert.equal(value.terminals.filter((t) => t.state === "running").length, 2);
  assert.notEqual(codex.workspaceId, opencode.workspaceId);
  await waitProof(opencode, "opencode-proof.txt", expected.opencode);
  await open(codex);
  await waitProof(codex, "codex-proof.txt", expected.codex);
  await assert.rejects(stat(join(process.env.KAIRO_NATIVE_PROJECT, "codex-proof.txt")), /ENOENT/);
  await assert.rejects(stat(join(codex.directory, "opencode-proof.txt")), /ENOENT/);
  await assert.rejects(stat(join(opencode.directory, "codex-proof.txt")), /ENOENT/);
  await button("Review");
  await until(() =>
    evaluate(
      "Array.from(document.querySelectorAll('.changed-file-button')).some(n=>n.textContent.includes('codex-proof.txt'))",
    ),
  );
  await capture("codex-review.png");
  await open(opencode);
  await until(() =>
    evaluate(
      "Array.from(document.querySelectorAll('.changed-file-button')).some(n=>n.textContent.includes('opencode-proof.txt'))",
    ),
  );
  await capture("opencode-review.png");
  await writeFile(
    join(output, "workflow.json"),
    JSON.stringify(
      { codex, opencode, concurrentTerminals: true, isolatedFiles: true, review: true },
      null,
      2,
    ),
  );
  await writeFile(join(output, "terminal-pids.json"), JSON.stringify([...pids]));
  console.log("Installed native desktop workflow proved");
  app.quit();
}
void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
