import type { WorkspaceTerminal } from "../../shared/api.js";

/**
 * Display names for plain shells: the name the user chose, else "Terminal N" counted within the
 * workspace. Agent terminals are named by their session instead.
 */
export function shellLabels(terminals: WorkspaceTerminal[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    if (terminal.sessionId) continue;
    const number = (counts.get(terminal.workspaceId) ?? 0) + 1;
    counts.set(terminal.workspaceId, number);
    labels.set(terminal.id, terminal.named ? terminal.title : `Terminal ${number}`);
  }
  return labels;
}
