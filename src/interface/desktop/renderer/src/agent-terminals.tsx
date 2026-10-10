import React from "react";
import { TerminalView } from "./terminal-view.js";
import type { WorkspaceTerminal } from "../../shared/api.js";
/** Keep live views mounted across navigation so alternate screens and scrollback remain intact. */
export default function AgentTerminals({
  terminals,
  activeTerminalId,
  onError,
}: {
  terminals: WorkspaceTerminal[];
  activeTerminalId?: string;
  onError(error: string): void;
}): React.JSX.Element {
  return (
    <div
      className="agent-terminal-stack"
      hidden={!activeTerminalId || !terminals.some((terminal) => terminal.id === activeTerminalId)}
    >
      {terminals.map((terminal) => (
        <TerminalView
          key={terminal.id}
          info={terminal}
          visible={terminal.id === activeTerminalId}
          onError={onError}
        />
      ))}
    </div>
  );
}
