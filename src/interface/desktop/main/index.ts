import {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { readSavedZoom, writeSavedZoom, ZOOM_MAX, ZOOM_MIN } from "./zoom-state.js";
import { pathToFileURL } from "node:url";
import { backendReadiness } from "./backend-readiness.js";

const appRoot = process.cwd();
const appIconPath = join(appRoot, "src/interface/desktop/assets/kairo-icon.png");
let mainWindow: BrowserWindow | undefined;
let backend: ChildProcessWithoutNullStreams | undefined;
let backendReady: Promise<void>;
let nextRequestId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Zoom steps of 10%, within a range where the layout stays usable. */
let zoomFactor = 1;

const zoomFile = () => join(app.getPath("userData"), "window-state.json");
/** `announce` is false when restoring the saved zoom at launch, which should not pop the pill. */
function setZoom(next: number, announce = true): number {
  zoomFactor = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 10) / 10;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(zoomFactor);
    // The top bar scales with the page, so keep the traffic lights centred in it.
    if (process.platform === "darwin")
      mainWindow.setWindowButtonPosition({
        x: Math.round(18 * zoomFactor),
        y: Math.round(22 * zoomFactor - 7),
      });
  }
  if (announce) writeSavedZoom(zoomFile(), zoomFactor);
  send("zoom:changed", { percent: Math.round(zoomFactor * 100), announce });
  return Math.round(zoomFactor * 100);
}

function buildMenu(): Menu {
  const zoomItems: MenuItemConstructorOptions[] = [
    { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => setZoom(1) },
    { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => setZoom(zoomFactor + 0.1) },
    // The unshifted key on most layouts; hidden so the menu lists one Zoom In.
    {
      label: "Zoom In",
      accelerator: "CmdOrCtrl+=",
      visible: false,
      click: () => setZoom(zoomFactor + 0.1),
    },
    { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => setZoom(zoomFactor - 0.1) },
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function assertTrusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  const sender = event.sender;
  const trusted = !!mainWindow && sender === mainWindow.webContents;
  if (!trusted || event.senderFrame !== sender.mainFrame)
    throw new Error("Untrusted desktop IPC sender.");
}

function startBackend(): Promise<void> {
  const root = appRoot;
  const entry = join(root, "out/main/backend.js");
  backend = spawn(process.env.KAIRO_NODE_EXECUTABLE || "node", [entry], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  backend.stderr.on("data", (chunk: Buffer) =>
    console.error(`[kairo backend] ${chunk.toString().trimEnd()}`),
  );
  backend.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    send("runtime:error", { error: error.message });
  });
  backend.on("exit", (code) => {
    const error = new Error(`Kairo runtime stopped${code === null ? "" : ` (${code})`}.`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (!backendShutdownComplete) send("runtime:error", { error: error.message });
  });
  const readiness = backendReadiness(backend);
  const lines = createInterface({ input: backend.stdout });
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return console.error(`[kairo backend] Invalid protocol message: ${line}`);
    }
    if (message.event === "ready") {
      readiness.succeed();
      return;
    }
    if (message.event === "ready_error") {
      readiness.fail(new Error(String(message.payload)));
      return;
    }
    if (typeof message.event === "string") {
      send(message.event, message.payload);
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (typeof message.error === "string") request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  backendReady = readiness.ready;
  return readiness.ready;
}

async function request<T>(method: string, args: unknown[] = []): Promise<T> {
  await backendReady;
  if (!backend || backend.killed || !backend.stdin.writable)
    throw new Error("Kairo runtime is unavailable.");
  const id = ++nextRequestId;
  const response = new Promise<T>((resolveResponse, rejectResponse) => {
    pending.set(id, {
      resolve: resolveResponse as (value: unknown) => void,
      reject: rejectResponse,
    });
  });
  backend.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  return response;
}

function registerIpc(): void {
  const handle = (channel: string, method: string) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrusted(event);
      return request(method, args);
    });
  ipcMain.handle("zoom:adjust", (event, delta: unknown) => {
    assertTrusted(event);
    return setZoom(zoomFactor + (typeof delta === "number" ? delta : 0));
  });
  ipcMain.handle("app:open-external", async (event, link: unknown) => {
    assertTrusted(event);
    const url = new URL(String(link));
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Only web links can be opened.");
    await shell.openExternal(url.href);
  });
  ipcMain.handle("zoom:reset", (event) => {
    assertTrusted(event);
    return setZoom(1);
  });
  handle("desktop:bootstrap", "bootstrap");
  handle("sessions:archived", "sessions:archived");
  handle("workspace:operation", "workspace:operation");
  handle("terminal:list", "terminal:list");
  handle("terminal:create", "terminal:create");
  handle("terminal:attach", "terminal:attach");
  handle("terminal:detach", "terminal:detach");
  handle("terminal:ack", "terminal:ack");
  handle("terminal:write", "terminal:write");
  handle("terminal:resize", "terminal:resize");
  handle("terminal:close", "terminal:close");
  handle("terminal:rename", "terminal:rename");
  handle("chat:thread", "chat:thread");
  handle("chat:append", "chat:append");
  handle("chat:import", "chat:import");

  ipcMain.handle("workspace:open", async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return request("workspace:open", [result.filePaths[0]]);
  });
  ipcMain.handle("workspace:pick", async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle("session:open", "session:open");
  handle("session:new", "session:new");
  handle("session:start", "session:start");
  handle("session:stop", "session:stop");
  handle("session:native", "session:native");
  handle("session:rename", "session:rename");
  handle("session:archive", "session:archive");
  handle("session:restore", "session:restore");
  handle("session:delete", "session:delete");
  handle("sessions:delete-archived", "sessions:delete-archived");
  handle("worktrees:list", "worktrees:list");
  handle("worktrees:remove", "worktrees:remove");
  handle("project:remove", "project:remove");
  handle("chat:create", "chat:create");
  handle("workspace:delete", "workspace:delete");
  handle("workspace:select", "workspace:select");
  for (const action of [
    "create",
    "preferences",
    "refs",
    "refresh",
    "rename",
    "pin",
    "archive",
    "restore",
    "tab",
    "cancel",
    "retry",
  ])
    handle(`workspace:${action}`, `workspace:${action}`);
  handle("agents:refresh", "agents:refresh");
  handle("workspace:directory", "workspace:directory");
  handle("workspace:snapshot", "workspace:snapshot");
  handle("workspace:search", "workspace:search");
  handle("workspace:review", "workspace:review");
  handle("workspace:diff", "workspace:diff");
  ipcMain.handle("agents:homepage", async (event, agentId: unknown) => {
    assertTrusted(event);
    const url = new URL(await request<string>("agents:homepage", [agentId]));
    if (url.protocol !== "https:") throw new Error("Invalid agent installation link.");
    await shell.openExternal(url.href);
  });
  ipcMain.handle("workspace:open-cursor", async (event, sessionId: unknown, filePath: unknown) => {
    assertTrusted(event);
    if (process.platform !== "darwin")
      throw new Error("Opening changed files in Cursor is currently supported on macOS.");
    const absolutePath = await request<string>("workspace:cursor-path", [sessionId, filePath]);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      execFile("open", ["-a", "Cursor", "--", absolutePath], (error) => {
        if (error) rejectOpen(new Error(`Could not open Cursor: ${error.message}`));
        else resolveOpen();
      });
    });
  });
}

const webPreferences = {
  preload: join(appRoot, "out/preload/index.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

/** Windows load only the bundled renderer (or the dev server) and never open or navigate elsewhere. */
function loadRenderer(window: BrowserWindow, hash = ""): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const localUrl = pathToFileURL(join(appRoot, "out/renderer/index.html")).href;
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    target.hash = "";
    if (devUrl && target.origin === new URL(devUrl).origin) return;
    if (!devUrl && target.href === localUrl) return;
    event.preventDefault();
  });
  if (devUrl) void window.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void window.loadFile(join(appRoot, "out/renderer/index.html"), hash ? { hash } : undefined);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: "Kairo",
    icon: appIconPath,
    // The top bar draws into the title bar area, like Claude's desktop app; only the traffic
    // lights stay native.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 15 } }
      : {}),
    webPreferences,
  });
  loadRenderer(mainWindow);
  // Reopen at the zoom the app was quit at; this also tells the renderer which zoom it is at.
  mainWindow.webContents.once("did-finish-load", () => setZoom(readSavedZoom(zoomFile()), false));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app
  .whenReady()
  .then(async () => {
    app.setName("Kairo");
    if (process.platform === "darwin") {
      app.dock?.setIcon(nativeImage.createFromPath(appIconPath));
    }
    await startBackend();
    registerIpc();
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error(`Kairo Desktop could not start: ${(error as Error).message}`);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
let backendShutdownComplete = false;
let backendShutdownStarted = false;
app.on("before-quit", (event) => {
  if (backendShutdownComplete || !backend) return;
  event.preventDefault();
  if (backendShutdownStarted) return;
  backendShutdownStarted = true;
  void request("shutdown")
    .catch((error: unknown) => {
      console.error(`Kairo runtime shutdown failed: ${(error as Error).message}`);
    })
    .finally(() => {
      backendShutdownComplete = true;
      backend?.stdin.end();
      app.quit();
    });
});
