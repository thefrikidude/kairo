/** File ownership is independent of the conversation and its native agent identity. */
export interface TaskWorkspace {
  id: string;
  repositoryPath: string;
  directory: string;
  kind: "folder" | "checkout" | "worktree";
  branch?: string;
  /** Commit used for workspace review; stays stable when its branch advances. */
  baseCommit?: string;
  managed: boolean;
  createdAt: number;
  removedAt?: number;
  name?: string;
  pinned?: boolean;
  archivedAt?: number;
  lastTab?: string;
  unavailable?: boolean;
}

export type WorkspaceSelection =
  | { kind: "folder" }
  | { kind: "existing"; directory: string }
  | { kind: "worktree"; branch: string; baseRef?: string };

export type GitWorktree = {
  directory: string;
  branch?: string;
  head: string;
  locked: boolean;
  prunable: boolean;
};

export type ProjectPreferences = {
  repositoryPath: string;
  baseRef?: string;
  setupScript: string;
  copyPaths: string[];
};
export type WorkspaceCreation = {
  project: string;
  name: string;
  selection: WorkspaceSelection;
  agentId?: string;
};
export type WorkspaceOperation = {
  id: string;
  repositoryPath: string;
  directory: string;
  name: string;
  branch?: string;
  baseCommit?: string;
  agentId?: string;
  workspaceId?: string;
  phase: "checkout" | "copy" | "setup" | "ready" | "failed" | "cancelled" | "interrupted";
  preferences: ProjectPreferences;
  copiedPaths: string[];
  output: string;
  error?: string;
  createdAt: number;
};
export type ProjectRefs = { refs: string[]; defaultRef: string; git: boolean };
