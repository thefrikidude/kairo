import type { ExternalAgentInfo, SessionRuntime } from "../../../domain/agent-runtime.js";
import type {
  Message,
  ModelSelection,
  Task,
  TaskEvent,
  ToolCall,
  WorkspaceEditPermission,
} from "../../../domain/models.js";
import type { Session } from "../../../infrastructure/persistence/sqlite-session-store.js";

export type DesktopProvider = {
  id: ModelSelection["provider"];
  name: string;
  environmentVariable: string;
  hasCredential: boolean;
  models: Array<{ id: string; label: string; recommended?: boolean }>;
};

export type LiveSession = {
  state: "running" | "waiting" | "cancelling" | "complete" | "cancelled" | "error";
  startedAt: number;
  finishedAt?: number;
  stream: string;
  events: TaskEvent[];
  error?: string;
};
export type DesktopBootstrap = {
  agents: ExternalAgentInfo[];
  liveSessions: Record<string, LiveSession>;
  approvals: DesktopApproval[];
  sessions: Session[];
  archivedSessions: Session[];
  activeSessionId?: string;
  config: ModelSelection;
  hasCredential: boolean;
  providers: DesktopProvider[];
  messages: Message[];
  task?: Task;
};

export type DesktopApproval = {
  id: string;
  sessionId: string;
  toolName: string;
  description: string;
  canAllowFile: boolean;
};

export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  openWorkspace(): Promise<DesktopBootstrap | undefined>;
  pickWorkspace(): Promise<string | undefined>;
  openSession(sessionId: string): Promise<DesktopBootstrap>;
  newSession(runtime: SessionRuntime, workspace: string): Promise<DesktopBootstrap>;
  setRuntime(sessionId: string, runtime: SessionRuntime): Promise<DesktopBootstrap>;
  refreshAgents(): Promise<ExternalAgentInfo[]>;
  loginAgent(agentId: string): Promise<void>;
  archiveSession(sessionId: string): Promise<DesktopBootstrap>;
  restoreSession(sessionId: string): Promise<DesktopBootstrap>;
  deleteSession(sessionId: string): Promise<DesktopBootstrap>;
  deleteArchivedSessions(): Promise<DesktopBootstrap>;
  archiveProject(workspace: string): Promise<DesktopBootstrap>;
  deleteProject(workspace: string): Promise<DesktopBootstrap>;
  send(sessionId: string, prompt: string, mode: "build" | "plan"): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  readFile(sessionId: string, path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  changedFiles(sessionId: string): Promise<string[]>;
  diff(sessionId: string, path: string): Promise<{ diff: string; unavailable?: string }>;
  openInCursor(sessionId: string, path: string): Promise<void>;
  saveModel(selection: ModelSelection, apiKey?: string): Promise<DesktopBootstrap>;
  resolveApproval(id: string, decision: "approve" | "task_file" | "deny"): Promise<void>;
  onChunk(listener: (event: { sessionId: string; chunk: string }) => void): () => void;
  onTaskState(
    listener: (event: { sessionId: string; state: string; task?: Task; error?: string }) => void,
  ): () => void;
  onTaskEvent(listener: (event: TaskEvent & { sessionId: string }) => void): () => void;
  onApproval(listener: (approval: DesktopApproval) => void): () => void;
  onRuntimeError(listener: (event: { error: string }) => void): () => void;
}

declare global {
  interface Window {
    kairo: DesktopApi;
  }
}

export type { Message, Task, TaskEvent, ToolCall, WorkspaceEditPermission };
