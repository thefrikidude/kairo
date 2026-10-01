import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/api.js";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  pickWorkspace: () => ipcRenderer.invoke("workspace:pick"),
  openSession: (sessionId) => ipcRenderer.invoke("session:open", sessionId),
  newSession: (runtime, workspace) => ipcRenderer.invoke("session:new", runtime, workspace),
  setRuntime: (sessionId, runtime) => ipcRenderer.invoke("session:runtime", sessionId, runtime),
  refreshAgents: () => ipcRenderer.invoke("agents:refresh"),
  loginAgent: (agentId) => ipcRenderer.invoke("agents:login", agentId),
  archiveSession: (sessionId) => ipcRenderer.invoke("session:archive", sessionId),
  restoreSession: (sessionId) => ipcRenderer.invoke("session:restore", sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  deleteArchivedSessions: () => ipcRenderer.invoke("sessions:delete-archived"),
  archiveProject: (workspace) => ipcRenderer.invoke("project:archive", workspace),
  deleteProject: (workspace) => ipcRenderer.invoke("project:delete", workspace),
  send: (sessionId, prompt, mode) => ipcRenderer.invoke("task:send", sessionId, prompt, mode),
  cancel: (sessionId) => ipcRenderer.invoke("task:cancel", sessionId),
  listFiles: (sessionId) => ipcRenderer.invoke("workspace:list", sessionId),
  readFile: (sessionId, path) => ipcRenderer.invoke("workspace:read", sessionId, path),
  saveFile: (sessionId, path, content) =>
    ipcRenderer.invoke("workspace:write", sessionId, path, content),
  changedFiles: (sessionId) => ipcRenderer.invoke("workspace:changes", sessionId),
  diff: (sessionId, path) => ipcRenderer.invoke("workspace:diff", sessionId, path),
  openInCursor: (sessionId, path) => ipcRenderer.invoke("workspace:open-cursor", sessionId, path),
  saveModel: (selection, apiKey) => ipcRenderer.invoke("model:save", selection, apiKey),
  resolveApproval: (id, decision) => ipcRenderer.invoke("approval:resolve", id, decision),
  onChunk: (listener) => subscribe("task:chunk", listener),
  onTaskState: (listener) => subscribe("task:state", listener),
  onTaskEvent: (listener) => subscribe("task:event", listener),
  onApproval: (listener) => subscribe("approval:request", listener),
  onRuntimeError: (listener) => subscribe("runtime:error", listener),
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("kairo", api);
