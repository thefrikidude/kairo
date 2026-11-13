import React from "react";
import { TerminalView } from "./terminal-view.js";
import type { WorkspaceTerminal } from "../../shared/api.js";
import type { Rect } from "./pane-slots.js";

/**
 * Live terminals stay mounted for the life of the app so alternate screens and scrollback survive
 * navigation. Each visible one is positioned over its pane's body, which lets several panes show
 * terminals at once without moving (and so restarting) any of them.
 */
export default function AgentTerminals({
  terminals,
  placements,
  focusedId,
  onError,
}: {
  terminals: WorkspaceTerminal[];
  placements: Record<string, Rect | undefined>;
  focusedId?: string;
  onError(error: string): void;
}): React.JSX.Element {
  return (
    <div className="agent-terminal-stack">
      {terminals.map((terminal) => {
        const place = placements[terminal.id];
        return (
          <div
            key={terminal.id}
            className="terminal-slot"
            style={
              place
                ? { left: place.left, top: place.top, width: place.width, height: place.height }
                : { display: "none" }
            }
          >
            <TerminalView
              info={terminal}
              visible={!!place}
              takeFocus={terminal.id === focusedId}
              onError={onError}
            />
          </div>
        );
      })}
    </div>
  );
}
