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
  operationName,
  operationId,
  runningAgents,
  projectTabs,
  stoppedSessions,
  activeTerminalId,
  current,
  selectedShell,
  pending,
  creatingShell,
  menuHandlers,
  agentActions,
  action,
  selectionVersion,
  setShellId,
  setError,
  newShell,
  beginSession,
}: {
  workspace?: TaskWorkspace;
  state?: DesktopBootstrap;
  operationName?: string;
  operationId?: string;
  runningAgents: number;
  projectTabs: Terminal[];
  stoppedSessions: Session[];
  activeTerminalId?: string;
  current?: Session;
  selectedShell?: Terminal;
  pending: boolean;
  creatingShell: boolean;
  menuHandlers(label: string, actions: ContextAction[]): React.HTMLAttributes<HTMLElement>;
  agentActions(id: string): ContextAction[];
  action(operation: () => Promise<DesktopBootstrap | undefined>): Promise<void>;
  selectionVersion: React.MutableRefObject<number>;
  setShellId(id: string | undefined): void;
  setError(value: string): void;
  newShell(): Promise<void>;
  beginSession(): void;
}): React.JSX.Element {
  return (
    <>
      <strong className="workspace-heading">
        {operationId ? operationName : (workspace?.name ?? "Kairo")}
      </strong>
      {!operationId && runningAgents > 1 && (
        <span
          className="shared-chip"
          role="status"
          title="These agents edit the same files. Use a separate workspace to keep their changes apart."
        >
          {runningAgents} agents share these files
        </span>
      )}
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
              `${terminal.title} tab actions`,
              terminal.sessionId
                ? agentActions(terminal.sessionId)
                : [
                    {
                      label: "Close terminal",
                      disabled: pending,
                      run: () =>
                        void action(async () => {
                          await window.kairo.closeTerminal(terminal.id);
                          return window.kairo.bootstrap(true);
                        }),
                    },
                  ],
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
              ? (state?.sessions.find((s) => s.id === terminal.sessionId)?.title ?? terminal.title)
              : `Terminal ${projectTabs.filter((t) => !t.sessionId).findIndex((t) => t.id === terminal.id) + 1}`}
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
      <div className="terminal-tab-actions">
        <Button
          variant="ghost"
          size="sm"
          aria-label="New terminal tab"
          disabled={
            !workspace ||
            !!workspace.removedAt ||
            !!workspace.archivedAt ||
            !!workspace.unavailable ||
            creatingShell
          }
          onClick={() => void newShell()}
        >
          + Terminal
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New agent tab"
          disabled={pending || !workspace || !!workspace.archivedAt || !!workspace.unavailable}
          onClick={() => beginSession()}
        >
          + Agent
        </Button>
      </div>
    </>
  );
}
