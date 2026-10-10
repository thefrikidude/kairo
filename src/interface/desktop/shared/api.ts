import type {
  WorkspaceTerminal,
  TerminalSnapshot,
  TerminalData,
} from "../../../domain/workspace-terminal.js";
export type { WorkspaceTerminal, TerminalSnapshot, TerminalData };
import type {
  GitWorktree,
  TaskWorkspace,
  WorkspaceSelection,
} from "../../../domain/task-workspace.js";
import type {
  WorkspaceReview,
  ReviewScope,
} from "../../../infrastructure/tools/workspace-review.js";
import type { AgentUsage } from "../../../domain/agent-usage.js";
import type { AgentAnswers, AgentQuestion } from "../../../domain/agent-user-input.js";
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

export type {
  FileSnapshot,
  FileSearch,
  WorkspaceEntry,
} from "../../../infrastructure/tools/workspace-files.js";

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
  userInputs: DesktopUserInput[];
  sessions: Session[];
  workspaces: TaskWorkspace[];
  archivedSessions: Session[];
  activeSessionId?: string;
  config: ModelSelection;
  hasCredential: boolean;
  providers: DesktopProvider[];
  messages: Message[];
  task?: Task;
  taskEvents: TaskEvent[];
};

export type DesktopUserInput = { id: string; sessionId: string; questions: AgentQuestion[] };

export type DesktopApproval = {
  id: string;
  sessionId: string;
  toolName: string;
  description: string;
  canAllowFile: boolean;
};

export interface DesktopApi {
  listTerminals(workspaceId?: string): Promise<WorkspaceTerminal[]>;
  createTerminal(workspaceId: string, reuse?: boolean): Promise<WorkspaceTerminal>;
  attachTerminal(id: string): Promise<TerminalSnapshot>;
  detachTerminal(id: string): Promise<void>;
  acknowledgeTerminal(id: string, sequence: number): Promise<void>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, columns: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminalData(listener: (event: TerminalData) => void): () => void;
  onTerminalState(listener: (terminal: WorkspaceTerminal) => void): () => void;
  onTerminalClosed(listener: (event: { id: string; workspaceId: string }) => void): () => void;
  setUnsavedChanges(dirty: boolean): void;
  bootstrap(): Promise<DesktopBootstrap>;
  openWorkspace(): Promise<DesktopBootstrap | undefined>;
  pickWorkspace(): Promise<string | undefined>;
  openSession(sessionId: string): Promise<DesktopBootstrap>;
  newSession(
    runtime: SessionRuntime,
    workspace: string,
    selection?: WorkspaceSelection,
  ): Promise<DesktopBootstrap>;
  listWorktrees(project: string): Promise<GitWorktree[]>;
  removeWorktree(workspaceId: string): Promise<DesktopBootstrap>;
  /** Switching agents stops an active turn, saves a handoff, then continues it in a fresh native session. */
  setRuntime(sessionId: string, runtime: SessionRuntime): Promise<DesktopBootstrap>;
  readUsage(sessionId: string, force?: boolean): Promise<AgentUsage>;
  onUsage(listener: (usage: AgentUsage) => void): () => void;
  refreshAgents(): Promise<ExternalAgentInfo[]>;
  loginAgent(agentId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<DesktopBootstrap>;
  directory(
    sessionId: string,
    path?: string,
  ): Promise<import("../../../infrastructure/tools/workspace-files.js").WorkspaceEntry[]>;
  archiveSession(sessionId: string): Promise<DesktopBootstrap>;
  restoreSession(sessionId: string): Promise<DesktopBootstrap>;
  deleteSession(sessionId: string): Promise<DesktopBootstrap>;
  deleteArchivedSessions(): Promise<DesktopBootstrap>;
  archiveProject(workspace: string): Promise<DesktopBootstrap>;
  deleteProject(workspace: string): Promise<DesktopBootstrap>;
  send(
    sessionId: string,
    prompt: string,
    mode: "build" | "plan",
    codexMode?: "default" | "plan",
  ): Promise<void>;
  codexCommand(
    sessionId: string,
    command: "plan" | "default" | "model" | "compact",
    argument?: string,
  ): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  readFile(sessionId: string, path: string): Promise<string>;
  fileSnapshot(
    sessionId: string,
    path: string,
  ): Promise<import("../../../infrastructure/tools/workspace-files.js").FileSnapshot>;
  searchFiles(
    sessionId: string,
    query: string,
  ): Promise<import("../../../infrastructure/tools/workspace-files.js").FileSearch>;
  saveFile(
    sessionId: string,
    path: string,
    content: string,
    revision: string,
  ): Promise<import("../../../infrastructure/tools/workspace-files.js").FileSnapshot>;
  changedFiles(sessionId: string): Promise<string[]>;
  review(sessionId: string, scope?: ReviewScope): Promise<WorkspaceReview>;
  diff(
    sessionId: string,
    path: string,
    scope?: ReviewScope,
  ): Promise<{ diff: string; unavailable?: string }>;
  openInCursor(sessionId: string, path: string): Promise<void>;
  saveModel(selection: ModelSelection, apiKey?: string): Promise<DesktopBootstrap>;
  resolveApproval(id: string, decision: "approve" | "task_file" | "deny"): Promise<void>;
  answerUserInput(id: string, answers: AgentAnswers): Promise<void>;
  onUserInput(listener: (request: DesktopUserInput) => void): () => void;
  onUserInputResolved(listener: (event: { id: string; sessionId: string }) => void): () => void;
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
