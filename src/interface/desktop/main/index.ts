import {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  nativeImage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const appRoot = process.cwd();
const appIconPath = join(appRoot, "src/interface/desktop/assets/kairo-icon.png");
let mainWindow: BrowserWindow | undefined;
let backend: ChildProcessWithoutNullStreams | undefined;
let unsavedChanges = false;
let backendReady: Promise<void>;
let nextRequestId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function assertTrusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("Untrusted desktop IPC sender.");
}

function startBackend(): Promise<void> {
  const root = appRoot;
  const entry = join(root, "src/interface/desktop/backend/protocol.ts");
  backend = spawn(join(root, "node_modules/.bin/tsx"), [entry], {
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
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const lines = createInterface({ input: backend!.stdout });
    const timeout = setTimeout(
      () => rejectReady(new Error("Kairo runtime did not start in time.")),
      30_000,
    );
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return console.error(`[kairo backend] Invalid protocol message: ${line}`);
      }
      if (message.event === "ready") {
        clearTimeout(timeout);
        resolveReady();
        return;
      }
      if (message.event === "ready_error") {
        clearTimeout(timeout);
        rejectReady(new Error(String(message.payload)));
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
    backend!.once("exit", () => {
      clearTimeout(timeout);
      rejectReady(new Error("Kairo runtime exited before it was ready."));
    });
  });
  backendReady = ready;
  return ready;
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
  ipcMain.on("workspace:unsaved", (event, dirty: unknown) => {
    assertTrusted(event);
    if (typeof dirty === "boolean") unsavedChanges = dirty;
  });
  const handle = (channel: string, method: string) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrusted(event);
      return request(method, args);
    });
  handle("desktop:bootstrap", "bootstrap");
  handle("terminal:list", "terminal:list");
  handle("terminal:create", "terminal:create");
  handle("terminal:attach", "terminal:attach");
  handle("terminal:detach", "terminal:detach");
  handle("terminal:ack", "terminal:ack");
  handle("terminal:write", "terminal:write");
  handle("terminal:resize", "terminal:resize");
  handle("terminal:close", "terminal:close");

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
  handle("session:rename", "session:rename");
  handle("workspace:directory", "workspace:directory");
  handle("worktrees:list", "worktrees:list");
  handle("worktrees:remove", "worktrees:remove");
  handle("session:new", "session:new");
  handle("session:runtime", "session:runtime");
  handle("agents:refresh", "agents:refresh");
  handle("agents:usage", "agents:usage");
  ipcMain.handle("agents:login", async (event, agentId: unknown) => {
    assertTrusted(event);
    const result = await request<{ url: string }>("agents:login", [agentId]);
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com")
      throw new Error("Agent returned an unrecognized sign-in URL.");
    await shell.openExternal(url.href);
  });
  handle("session:archive", "session:archive");
  handle("session:restore", "session:restore");
  handle("session:delete", "session:delete");
  handle("sessions:delete-archived", "sessions:delete-archived");
  handle("project:archive", "project:archive");
  handle("project:delete", "project:delete");
  handle("task:send", "task:send");
  handle("codex:command", "codex:command");
  handle("task:cancel", "task:cancel");
  handle("workspace:list", "workspace:list");
  handle("workspace:snapshot", "workspace:snapshot");
  handle("workspace:search", "workspace:search");
  handle("workspace:read", "workspace:read");
  handle("workspace:write", "workspace:write");
  handle("workspace:changes", "workspace:changes");
  handle("workspace:review", "workspace:review");
  handle("workspace:diff", "workspace:diff");
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
  handle("model:save", "model:save");
  handle("approval:resolve", "approval:resolve");
  handle("user-input:resolve", "user-input:resolve");
}

function confirmUnsavedChanges(): boolean {
  if (!unsavedChanges || !mainWindow || mainWindow.isDestroyed()) return true;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "warning",
    title: "Unsaved file edits",
    message: "You have unsaved file edits.",
    detail: "Save or copy them before quitting, or discard them to close Kairo.",
    buttons: ["Keep editing", "Discard and quit"],
    defaultId: 0,
    cancelId: 0,
  });
  if (choice !== 1) return false;
  unsavedChanges = false;
  return true;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: "Kairo",
    icon: appIconPath,
    webPreferences: {
      preload: join(appRoot, "out/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("close", (event) => {
    if (!confirmUnsavedChanges()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const localUrl = pathToFileURL(join(appRoot, "out/renderer/index.html")).href;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (devUrl && new URL(url).origin === new URL(devUrl).origin) return;
    if (!devUrl && url === localUrl) return;
    event.preventDefault();
  });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(appRoot, "out/renderer/index.html"));
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
  if (!backendShutdownStarted && !confirmUnsavedChanges()) {
    event.preventDefault();
    return;
  }
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
