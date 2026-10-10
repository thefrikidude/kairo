import type {
  TerminalAgentInfo,
  TerminalSession,
  NativeAgentSession,
  SessionStartMode,
} from "../../../domain/terminal-agent.js";
import type {
  TaskWorkspace,
  GitWorktree,
  WorkspaceSelection,
} from "../../../domain/task-workspace.js";
import type {
  WorkspaceTerminal,
  TerminalSnapshot,
  TerminalData,
} from "../../../domain/workspace-terminal.js";
import type {
  WorkspaceReview,
  ReviewScope,
} from "../../../infrastructure/tools/workspace-review.js";
import type {
  FileSnapshot,
  FileSearch,
  WorkspaceEntry,
} from "../../../infrastructure/tools/workspace-files.js";

export type {
  TerminalAgentInfo,
  TerminalSession,
  NativeAgentSession,
  SessionStartMode,
  TaskWorkspace,
  GitWorktree,
  WorkspaceSelection,
  WorkspaceTerminal,
  TerminalSnapshot,
  TerminalData,
  WorkspaceReview,
  ReviewScope,
  FileSnapshot,
  FileSearch,
  WorkspaceEntry,
};
export type TerminalDesktopBootstrap = {
  agents: TerminalAgentInfo[];
  sessions: TerminalSession[];
  archivedSessions: TerminalSession[];
  workspaces: TaskWorkspace[];
  terminals: WorkspaceTerminal[];
  activeSessionId?: string;
  activeWorkspaceId?: string;
  sessionErrors: Record<string, string>;
  sessionNotices: Record<string, string>;
};
export interface TerminalDesktopApi {
  bootstrap(): Promise<TerminalDesktopBootstrap>;
  openWorkspace(): Promise<TerminalDesktopBootstrap | undefined>;
  pickWorkspace(): Promise<string | undefined>;
  selectWorkspace(id: string): Promise<TerminalDesktopBootstrap>;
  openSession(id: string): Promise<TerminalDesktopBootstrap>;
  newSession(
    agentId: string,
    workspace: string,
    selection?: WorkspaceSelection,
  ): Promise<TerminalDesktopBootstrap>;
  startSession(id: string, mode?: SessionStartMode): Promise<TerminalDesktopBootstrap>;
  stopSession(id: string): Promise<TerminalDesktopBootstrap>;
  setNativeSession(
    id: string,
    nativeSession: NativeAgentSession,
  ): Promise<TerminalDesktopBootstrap>;
  renameSession(id: string, title: string): Promise<TerminalDesktopBootstrap>;
  archiveSession(id: string): Promise<TerminalDesktopBootstrap>;
  restoreSession(id: string): Promise<TerminalDesktopBootstrap>;
  deleteSession(id: string): Promise<TerminalDesktopBootstrap>;
  deleteArchivedSessions(): Promise<TerminalDesktopBootstrap>;
  refreshAgents(): Promise<TerminalAgentInfo[]>;
  openAgentHomepage(agentId: string): Promise<void>;
  listWorktrees(project: string): Promise<GitWorktree[]>;
  removeWorktree(id: string): Promise<TerminalDesktopBootstrap>;
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
  onRuntimeError(listener: (event: { error: string }) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
  setUnsavedChanges(dirty: boolean): void;
  directory(id: string, path?: string): Promise<WorkspaceEntry[]>;
  fileSnapshot(id: string, path: string): Promise<FileSnapshot>;
  searchFiles(id: string, query: string): Promise<FileSearch>;
  saveFile(id: string, path: string, content: string, revision: string): Promise<FileSnapshot>;
  review(id: string, scope?: ReviewScope): Promise<WorkspaceReview>;
  diff(
    id: string,
    path: string,
    scope?: ReviewScope,
  ): Promise<{ diff: string; unavailable?: string }>;
  openInCursor(id: string, path: string): Promise<void>;
}
