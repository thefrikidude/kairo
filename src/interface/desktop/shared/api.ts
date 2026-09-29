import type {
  Message,
  ModelSelection,
  Task,
  ToolCall,
  WorkspaceEditPermission,
} from "../../../domain/models.js";
import type { Session } from "../../../infrastructure/persistence/sqlite-session-store.js";

export type DesktopProvider = {
  id: ModelSelection["provider"];
  name: string;
  environmentVariable: string;
  models: Array<{ id: string; label: string; recommended?: boolean }>;
};

export type DesktopBootstrap = {
  sessions: Session[];
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
  openSession(sessionId: string): Promise<DesktopBootstrap>;
  newSession(): Promise<DesktopBootstrap>;
  send(sessionId: string, prompt: string, mode: "build" | "plan"): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  readFile(sessionId: string, path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  changedFiles(sessionId: string): Promise<string[]>;
  diff(sessionId: string, path: string): Promise<{ diff: string; unavailable?: string }>;
  saveModel(selection: ModelSelection, apiKey?: string): Promise<DesktopBootstrap>;
  resolveApproval(id: string, decision: "approve" | "task_file" | "deny"): Promise<void>;
  onChunk(listener: (event: { sessionId: string; chunk: string }) => void): () => void;
  onTaskState(
    listener: (event: { sessionId: string; state: string; task?: Task; error?: string }) => void,
  ): () => void;
  onApproval(listener: (approval: DesktopApproval) => void): () => void;
}

declare global {
  interface Window {
    kairo: DesktopApi;
  }
}

export type { Message, Task, ToolCall, WorkspaceEditPermission };
