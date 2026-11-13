import React from "react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import type { ContextAction } from "./context-menu.js";
import { activityClass, activityLabel } from "./activity.js";
import { navigateTabs } from "./tab-navigation.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Terminal = DesktopBootstrap["terminals"][number];
type Session = DesktopBootstrap["sessions"][number];

export function TerminalTabs({
  workspace,
  state,
  operationId,
  runningAgents,
  projectTabs,
  stoppedSessions,
  activeTerminalId,
  current,
  selectedShell,
  pending,
  menuHandlers,
  agentActions,
  shellActions,
  shellNames,
  action,
  selectionVersion,
  setShellId,
  setError,
}: {
  workspace?: TaskWorkspace;
  state?: DesktopBootstrap;
  operationId?: string;
  runningAgents: number;
  projectTabs: Terminal[];
  stoppedSessions: Session[];
  activeTerminalId?: string;
  current?: Session;
  selectedShell?: Terminal;
  pending: boolean;
  menuHandlers(label: string, actions: ContextAction[]): React.HTMLAttributes<HTMLElement>;
  agentActions(id: string): ContextAction[];
  shellActions(terminal: Terminal): ContextAction[];
  shellNames: Map<string, string>;
  action(operation: () => Promise<DesktopBootstrap | undefined>): Promise<void>;
  selectionVersion: React.MutableRefObject<number>;
  setShellId(id: string | undefined): void;
  setError(value: string): void;
}): React.JSX.Element {
  return (
    <>
      {!operationId && runningAgents > 1 && (
        <span
          className="shared-chip"
          role="status"
          title="These agents edit the same files. Use a separate workspace to keep their changes apart."
        >
          {runningAgents} agents share these files
        </span>
      )}
      {projectTabs.length + stoppedSessions.length > 1 ? (
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label="Terminal tabs"
          onKeyDown={navigateTabs}
        >
          {projectTabs.map((terminal) => (
            <button
              key={terminal.id}
              data-session-id={terminal.sessionId}
              disabled={pending || !!workspace?.archivedAt || !!workspace?.unavailable}
              role="tab"
              aria-selected={terminal.id === activeTerminalId}
              tabIndex={terminal.id === activeTerminalId ? 0 : -1}
              aria-controls={`terminal-view-${terminal.id}`}
              title={terminal.directory}
              {...menuHandlers(
                `${shellNames.get(terminal.id) ?? terminal.title} tab actions`,
                terminal.sessionId ? agentActions(terminal.sessionId) : shellActions(terminal),
              )}
              onClick={() => {
                selectionVersion.current++;
                if (terminal.sessionId) {
                  setShellId(undefined);
                  void action(() => window.kairo.openSession(terminal.sessionId!));
                } else {
                  setShellId(terminal.id);
                  void window.kairo
                    .rememberWorkspaceTab(terminal.workspaceId, `terminal:${terminal.id}`)
                    .catch((cause) => setError(message(cause)));
                }
              }}
            >
              {terminal.state === "running" &&
                (terminal.activity === "working" || terminal.activity === "waiting") && (
                  <span
                    className={`tab-status ${activityClass[terminal.activity]}`}
                    title={activityLabel[terminal.activity]}
                    aria-hidden="true"
                  />
                )}
              {terminal.sessionId
                ? (state?.sessions.find((s) => s.id === terminal.sessionId)?.title ??
                  terminal.title)
                : (shellNames.get(terminal.id) ?? terminal.title)}
            </button>
          ))}
          {stoppedSessions.map((session) => (
            <button
              key={session.id}
              data-session-id={session.id}
              disabled={pending || !!workspace?.archivedAt || !!workspace?.unavailable}
              {...menuHandlers(`${session.title} tab actions`, agentActions(session.id))}
              role="tab"
              aria-selected={session.id === current?.id && !selectedShell}
              tabIndex={session.id === current?.id ? 0 : -1}
              onClick={() => {
                selectionVersion.current++;
                void action(() => window.kairo.openSession(session.id));
              }}
            >
              {session.title} · stopped
            </button>
          ))}
        </div>
      ) : (
        <span className="flex-1" />
      )}
    </>
  );
}
