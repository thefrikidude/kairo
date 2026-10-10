const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
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
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
app.on("browser-window-created", (_event, window) => {
  win = window;
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") failures.push(event.message);
  });
  window.webContents.once("did-finish-load", () => {
    void run().catch((error) => {
      console.error(error);
      app.on("quit", () => process.exit(1));
      app.quit();
    });
  });
});
async function run() {
  await waitFor("document.querySelector('.session[aria-current=page]')");
  const startupMs = performance.now() - started;
  assert.equal(await evaluate("document.querySelector('#workspace-panel').hidden"), true);
  assert.equal(await evaluate("!!document.querySelector('.status-complete')"), true);
  await click(".session-row.selected .session-action-button[title='Rename session']");
  await waitFor("document.querySelector('#rename-session-title')");
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
  await click(".new-chat");
  await waitFor("document.querySelector('#new-session-title')");
  assert.equal(
    await evaluate("document.querySelector('.session-folder-picker small').textContent"),
    process.env.KAIRO_SMOKE_PROJECT,
  );
  await click(".session-picker-dialog button.primary");
  await waitFor("!document.querySelector('#new-session-title')");
  await click(".top-actions button[title^='Browse files']");
  await waitFor("document.querySelector('.file-entry')");
  await evaluate(
    "Array.from(document.querySelectorAll('.file-entry')).find(e => e.textContent.includes('src')).click()",
  );
  await waitFor("document.querySelector('.file-entry')?.textContent.includes('hello.ts')");
  await click(".file-entry");
  await waitFor(
    "document.querySelector('.file-preview')?.textContent.includes('Hello from the workspace')",
  );
  await click("button[aria-label='Reload file preview']");
  await waitFor(
    "document.querySelector('.file-preview')?.textContent.includes('Hello from the workspace')",
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Resize workspace panel\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))",
  );
  assert.equal(
    await evaluate(
      "Number(document.querySelector('[aria-label=\"Resize workspace panel\"]').getAttribute('aria-valuenow'))",
    ),
    440,
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
  await click("#changes-tab");
  await waitFor("document.querySelector('#changes-tab').getAttribute('aria-selected') === 'true'");
  await sleep(100);
  await win.webContents
    .capturePage()
    .then((img) =>
      writeFile(join(process.env.KAIRO_SMOKE_OUTPUT, "desktop-wide.png"), img.toPNG()),
    );
  win.setSize(900, 700);
  await sleep(150);
  const footer = await evaluate(
    "(() => { const e = document.querySelector('.agent-usage-footer'); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; })()",
  );
  assert.ok(footer && footer.bottom <= footer.height && footer.top >= 0);
  await win.webContents
    .capturePage()
    .then((img) =>
      writeFile(join(process.env.KAIRO_SMOKE_OUTPUT, "desktop-narrow.png"), img.toPNG()),
    );
  await click("button[aria-label='Close review']");
  await click(".settings-link");
  await waitFor("document.querySelector('.theme-options')");
  await evaluate(
    "Array.from(document.querySelectorAll('.theme-options button')).find(e => e.textContent === 'Light').click()",
  );
  await click(".settings-back");
  await waitFor("document.querySelector('.app-shell')?.dataset.theme === 'light'");
  await sleep(150);
  await win.webContents
    .capturePage()
    .then((img) =>
      writeFile(join(process.env.KAIRO_SMOKE_OUTPUT, "desktop-light.png"), img.toPNG()),
    );
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
