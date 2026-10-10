const { app } = require("electron");
const { writeFile } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { basename, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const started = performance.now();
app.setPath("userData", join(process.env.KAIRO_STATE_DIR, "electron"));
let win;
const failures = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const evaluate = (code) => win.webContents.executeJavaScript(code);
async function waitFor(code) {
  const deadline = Date.now() + 30_000;
  while (!(await evaluate(code))) {
    if (Date.now() > deadline) throw new Error(`Benchmark timed out: ${code}`);
    await sleep(10);
  }
}
app.on("browser-window-created", (_event, window) => {
  win = window;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") failures.push(event.message);
  });
  win.webContents.once(
    "did-finish-load",
    () =>
      void run().catch((error) => {
        console.error(error);
        process.exitCode = 1;
        app.quit();
      }),
  );
});
async function run() {
  win.show();
  win.focus();
  await waitFor("document.querySelector('.session-row.selected')");
  const startupMs = performance.now() - started;
  await sleep(1_000);
  const ids = await evaluate(
    "Array.from(document.querySelectorAll('.session-row')).map(item => item.dataset.sessionId)",
  );
  const switchMs = [];
  for (const id of ids.slice(1, 11)) {
    switchMs.push(
      await evaluate(`new Promise((done, fail) => {
      const started = performance.now();
      document.querySelector('[data-session-id="${id}"] .session').click();
      const frame = () => {
        if (performance.now() - started > 5000) return fail(new Error('Session switch exceeded five seconds'));
        if (document.querySelector('.session-row.selected')?.dataset.sessionId === ${JSON.stringify(id)}) return requestAnimationFrame(() => done(performance.now() - started));
        requestAnimationFrame(frame);
      }; requestAnimationFrame(frame);
    })`),
    );
  }
  await sleep(500);
  if (failures.length) throw new Error(failures.join("\n"));
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              rssKB: Number(match[3]),
              executable: basename(match[4]),
            },
          ]
        : [];
    });
  const owned = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const processes = rows.filter((row) => owned.has(row.pid) && row.executable !== "ps");
  const sample = {
    startupMs,
    switchMs,
    rssKB: processes.reduce((sum, row) => sum + row.rssKB, 0),
    processes,
    electronWorkingSets: app
      .getAppMetrics()
      .map(({ type, memory }) => ({ type, workingSetKB: memory.workingSetSize })),
  };
  await writeFile(process.env.KAIRO_BENCH_SAMPLE, JSON.stringify(sample, null, 2));
  console.log(
    `Benchmark startup ${Math.round(startupMs)} ms; total process RSS ${sample.rssKB} KB`,
  );
  app.quit();
}
void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
