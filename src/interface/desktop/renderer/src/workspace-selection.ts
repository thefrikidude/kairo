import type { TerminalDesktopApi, WorkspaceTerminal } from "../../shared/terminal-api.js";

export function rememberedShell(
  workspaceId: string | undefined,
  tab: string | undefined,
  terminals: WorkspaceTerminal[] = [],
): string | undefined {
  if (!workspaceId || !tab?.startsWith("terminal:")) return;
  const id = tab.slice(9);
  return terminals.some(
    (terminal) => terminal.id === id && terminal.workspaceId === workspaceId && !terminal.sessionId,
  )
    ? id
    : undefined;
}

/** A launch finishing in the background must not change the user's newer selection. */
export async function openWorkspaceShell(
  api: Pick<TerminalDesktopApi, "createTerminal" | "rememberWorkspaceTab">,
  workspaceId: string,
  receive: (terminal: WorkspaceTerminal) => void,
  isCurrent: () => boolean,
  select: (terminal: WorkspaceTerminal) => void,
): Promise<void> {
  const terminal = await api.createTerminal(workspaceId);
  receive(terminal);
  if (!isCurrent()) return;
  await api.rememberWorkspaceTab(workspaceId, `terminal:${terminal.id}`);
  if (isCurrent()) select(terminal);
}
