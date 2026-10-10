import React from "react";
import { TerminalView } from "./terminal-panel.js";
import type { WorkspaceTerminal } from "../../shared/api.js";
/** Keep live views mounted across navigation so alternate screens and scrollback remain intact. */
export default function AgentTerminals({
  terminals,
  activeSessionId,
  onError,
}: {
  terminals: WorkspaceTerminal[];
  activeSessionId?: string;
  onError(error: string): void;
}): React.JSX.Element {
  return (
    <div
      className="agent-terminal-stack"
      hidden={
        !activeSessionId || !terminals.some((terminal) => terminal.sessionId === activeSessionId)
      }
    >
      {terminals
        .filter((terminal) => terminal.sessionId)
        .map((terminal) => (
          <TerminalView
            key={terminal.id}
            info={terminal}
            visible={terminal.sessionId === activeSessionId}
            onError={onError}
          />
        ))}
    </div>
  );
}
