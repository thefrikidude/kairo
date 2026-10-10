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
  setUnsavedChanges: (dirty) => ipcRenderer.send("workspace:unsaved", dirty),
  bootstrap: () => invoke("desktop:bootstrap"),
  openWorkspace: () => invoke("workspace:open"),
  pickWorkspace: () => invoke("workspace:pick"),
  openSession: (sessionId) => invoke("session:open", sessionId),
  newSession: (runtime, workspace, selection) =>
    invoke("session:new", runtime, workspace, selection),
  listWorktrees: (project) => invoke("worktrees:list", project),
  removeWorktree: (workspaceId) => invoke("worktrees:remove", workspaceId),
  setRuntime: (sessionId, runtime) => invoke("session:runtime", sessionId, runtime),
  readUsage: (sessionId, force) => invoke("agents:usage", sessionId, force),
  onUsage: (listener) => subscribe("agents:usage", listener),
  refreshAgents: () => invoke("agents:refresh"),
  loginAgent: (agentId) => invoke("agents:login", agentId),
  renameSession: (sessionId, title) => invoke("session:rename", sessionId, title),
  directory: (sessionId, path) => invoke("workspace:directory", sessionId, path),
  archiveSession: (sessionId) => invoke("session:archive", sessionId),
  restoreSession: (sessionId) => invoke("session:restore", sessionId),
  deleteSession: (sessionId) => invoke("session:delete", sessionId),
  deleteArchivedSessions: () => invoke("sessions:delete-archived"),
  archiveProject: (workspace) => invoke("project:archive", workspace),
  deleteProject: (workspace) => invoke("project:delete", workspace),
  send: (sessionId, prompt, mode, codexMode) =>
    invoke("task:send", sessionId, prompt, mode, codexMode),
  codexCommand: (sessionId, command, argument) =>
    invoke("codex:command", sessionId, command, argument),
  cancel: (sessionId) => invoke("task:cancel", sessionId),
  listFiles: (sessionId) => invoke("workspace:list", sessionId),
  readFile: (sessionId, path) => invoke("workspace:read", sessionId, path),
  fileSnapshot: (sessionId, path) => invoke("workspace:snapshot", sessionId, path),
  searchFiles: (sessionId, query) => invoke("workspace:search", sessionId, query),
  saveFile: (sessionId, path, content, revision) =>
    invoke("workspace:write", sessionId, path, content, revision),
  changedFiles: (sessionId) => invoke("workspace:changes", sessionId),
  review: (sessionId, scope) => invoke("workspace:review", sessionId, scope),
  diff: (sessionId, path, scope) => invoke("workspace:diff", sessionId, path, scope),
  openInCursor: (sessionId, path) => invoke("workspace:open-cursor", sessionId, path),
  saveModel: (selection, apiKey) => invoke("model:save", selection, apiKey),
  resolveApproval: (id, decision) => invoke("approval:resolve", id, decision),
  answerUserInput: (id, answers) => invoke("user-input:resolve", id, answers),
  onUserInput: (listener) => subscribe("user-input:request", listener),
  onUserInputResolved: (listener) => subscribe("user-input:resolved", listener),
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
