import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/api.js";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  }
}

const api: DesktopApi = {
  bootstrap: () => invoke("desktop:bootstrap"),
  openWorkspace: () => invoke("workspace:open"),
  pickWorkspace: () => invoke("workspace:pick"),
  selectWorkspace: (id) => invoke("workspace:select", id),
  openSession: (id) => invoke("session:open", id),
  newSession: (agentId, workspace, selection) =>
    invoke("session:new", agentId, workspace, selection),
  startSession: (id, mode) => invoke("session:start", id, mode),
  stopSession: (id) => invoke("session:stop", id),
  setNativeSession: (id, nativeSession) => invoke("session:native", id, nativeSession),
  renameSession: (id, title) => invoke("session:rename", id, title),
  archiveSession: (id) => invoke("session:archive", id),
  restoreSession: (id) => invoke("session:restore", id),
  deleteSession: (id) => invoke("session:delete", id),
  deleteArchivedSessions: () => invoke("sessions:delete-archived"),
  refreshAgents: () => invoke("agents:refresh"),
  openAgentHomepage: (agentId) => invoke("agents:homepage", agentId),
  listWorktrees: (project) => invoke("worktrees:list", project),
  removeWorktree: (id) => invoke("worktrees:remove", id),
  listTerminals: (workspaceId) => invoke("terminal:list", workspaceId),
  createTerminal: (workspaceId, reuse) => invoke("terminal:create", workspaceId, reuse),
  attachTerminal: (id) => invoke("terminal:attach", id),
  detachTerminal: (id) => invoke("terminal:detach", id),
  acknowledgeTerminal: (id, sequence) => invoke("terminal:ack", id, sequence),
  writeTerminal: (id, data) => invoke("terminal:write", id, data),
  resizeTerminal: (id, columns, rows) => invoke("terminal:resize", id, columns, rows),
  closeTerminal: (id) => invoke("terminal:close", id),
  directory: (id, path) => invoke("workspace:directory", id, path),
  fileSnapshot: (id, path) => invoke("workspace:snapshot", id, path),
  searchFiles: (id, query) => invoke("workspace:search", id, query),
  saveFile: (id, path, content, revision) => invoke("workspace:write", id, path, content, revision),
  review: (id, scope) => invoke("workspace:review", id, scope),
  diff: (id, path, scope) => invoke("workspace:diff", id, path, scope),
  openInCursor: (id, path) => invoke("workspace:open-cursor", id, path),
  onTerminalData: (listener) => subscribe("terminal:data", listener),
  onTerminalState: (listener) => subscribe("terminal:state", listener),
  onTerminalClosed: (listener) => subscribe("terminal:closed", listener),
  onRuntimeError: (listener) => subscribe("runtime:error", listener),
  onSessionsChanged: (listener) => subscribe("sessions:changed", listener),
  setUnsavedChanges: (dirty) => ipcRenderer.send("workspace:unsaved", dirty),
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("kairo", api);
