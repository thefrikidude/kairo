/**
 * Best-effort view of what a terminal is doing, inferred from its output: `working` while output
 * is flowing, `waiting` when it went quiet on an approval-style prompt, otherwise `idle`.
 */
export type TerminalActivity = "working" | "waiting" | "idle";
/** A live PTY belongs to a workspace; agent PTYs also identify their durable session. */
export type WorkspaceTerminal = {
  id: string;
  workspaceId: string;
  sessionId?: string;
  directory: string;
  title: string;
  /** True once the user has chosen the title, so it replaces the numbered default. */
  named?: boolean;
  /** Command line of whatever runs in the foreground (for example an agent CLI); unset at an idle prompt. */
  foreground?: string;
  pid: number;
  state: "running" | "exited";
  activity: TerminalActivity;
  columns: number;
  rows: number;
  exitCode?: number;
};
export type TerminalSnapshot = WorkspaceTerminal & { buffer: string; sequence: number };
export type TerminalData = { id: string; workspaceId: string; data: string; sequence: number };
