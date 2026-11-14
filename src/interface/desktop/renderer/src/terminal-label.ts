import type { WorkspaceTerminal } from "../../shared/api.js";

/**
 * Display names for plain shells: the name the user chose, else "Terminal N" with the number the
 * terminal was given when it opened. Numbers do not shift when another shell closes, and a
 * freed number is reused by the next new shell. Agent terminals are named by their session.
 */
export function shellLabels(terminals: WorkspaceTerminal[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const terminal of terminals) {
    if (terminal.sessionId) continue;
    labels.set(terminal.id, terminal.named ? terminal.title : `Terminal ${terminal.number ?? 1}`);
  }
  return labels;
}
