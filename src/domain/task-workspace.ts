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
