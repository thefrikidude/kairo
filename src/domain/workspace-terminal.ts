/** Ephemeral utilities belong to a workspace, never to an agent conversation. */
export type WorkspaceTerminal = {
  id: string;
  workspaceId: string;
  directory: string;
  title: string;
  pid: number;
  state: "running" | "exited";
  columns: number;
  rows: number;
  exitCode?: number;
};
export type TerminalSnapshot = WorkspaceTerminal & { buffer: string; sequence: number };
export type TerminalData = { id: string; workspaceId: string; data: string; sequence: number };
