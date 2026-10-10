/** A live PTY belongs to a workspace; agent PTYs also identify their durable session. */
export type WorkspaceTerminal = {
  id: string;
  workspaceId: string;
  sessionId?: string;
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
