// Electron entry for verification runs. Starts Kairo with an isolated state directory and a
// loopback control server so an agent can inspect and drive the real app across many commands.
// Started only by `scripts/verify/control.mjs launch`; never run it against real user data.
const { app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

const { KAIRO_STATE_DIR, KAIRO_VERIFY_TOKEN, KAIRO_VERIFY_INFO, KAIRO_VERIFY_ARTIFACTS } =
  process.env;
if (!KAIRO_STATE_DIR || !KAIRO_VERIFY_TOKEN || !KAIRO_VERIFY_INFO || !KAIRO_VERIFY_ARTIFACTS) {
  console.error("host.cjs must be started by `node scripts/verify/control.mjs launch`.");
  process.exit(2);
}
app.setPath("userData", join(KAIRO_STATE_DIR, "electron"));

const windows = [];
const errors = [];
app.on("browser-window-created", (_, window) => {
  windows.push(window);
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
});

function target(body) {
  const window = windows[Number(body.window ?? 0)];
  if (!window || window.isDestroyed())
    throw new Error(`No open window at index ${body.window ?? 0}.`);
  return window;
}

const commands = {
  info: async () => ({ pid: process.pid, stateDir: KAIRO_STATE_DIR, cwd: process.cwd() }),
  windows: async () =>
    windows.map((window, index) => ({
      index,
      destroyed: window.isDestroyed(),
      title: window.isDestroyed() ? "" : window.getTitle(),
      hash: window.isDestroyed() ? "" : new URL(window.webContents.getURL()).hash,
    })),
  eval: async (body) => target(body).webContents.executeJavaScript(String(body.code)),
  click: async (body) => {
    const code = `(() => {
      const wanted = ${JSON.stringify(body.text ?? null)};
      const matches = [...document.querySelectorAll(${JSON.stringify(body.selector)})].filter(
        (node) => wanted === null || node.textContent.replace(/\\s+/g, " ").trim() === wanted,
      );
      if (!matches.length) return 0;
      matches[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return matches.length;
    })()`;
    const count = await target(body).webContents.executeJavaScript(code);
    if (!count)
      throw new Error(
        `No element matches ${body.selector}${body.text ? ` with text "${body.text}"` : ""}.`,
      );
    return { matches: count };
  },
  key: async (body) => {
    const window = target(body);
    window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: body.key,
      modifiers: body.modifiers ?? [],
    });
    window.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: body.key,
      modifiers: body.modifiers ?? [],
    });
    return {};
  },
  // Only this one window is captured, never the screen, and only into the run's artifacts folder.
  screenshot: async (body) => {
    const file = resolve(String(body.path));
    if (!file.startsWith(resolve(KAIRO_VERIFY_ARTIFACTS) + sep)) {
      throw new Error("Screenshots must be written inside the run's artifacts folder.");
    }
    const window = target(body);
    window.show();
    await new Promise((done) => setTimeout(done, 150));
    fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
    return { path: file };
  },
  errors: async (body) => {
    const copy = [...errors];
    if (body.clear) errors.length = 0;
    return copy;
  },
  quit: async () => {
    setTimeout(() => app.quit(), 50);
    return {};
  },
};

const server = http.createServer((request, response) => {
  const reply = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (request.method !== "POST" || request.headers["x-verify-token"] !== KAIRO_VERIFY_TOKEN) {
    return reply(403, { ok: false, error: "Forbidden." });
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) request.destroy();
  });
  request.on("end", async () => {
    try {
      const body = JSON.parse(raw || "{}");
      const handler = commands[body.cmd];
      if (!handler) return reply(400, { ok: false, error: `Unknown command: ${body.cmd}` });
      reply(200, { ok: true, result: (await handler(body)) ?? null });
    } catch (error) {
      reply(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(
    KAIRO_VERIFY_INFO,
    JSON.stringify({ pid: process.pid, port: server.address().port }),
    { mode: 0o600 },
  );
});
app.on("quit", () => server.close());

void import(pathToFileURL(join(process.cwd(), "out/main/index.js")).href);
