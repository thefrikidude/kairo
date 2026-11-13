import React from "react";
import type { DesktopBootstrap, TaskWorkspace, WorkspaceTerminal } from "../../shared/api.js";
import { SquareTerminal } from "lucide-react";
import { Icon } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import type { ContextAction } from "./context-menu.js";

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

type Dispatch<T> = React.Dispatch<React.SetStateAction<T>>;

export function Sidebar({
  hidden,
  pending,
  state,
  groups,
  chats,
  collapsed,
  setCollapsed,
  selecting,
  setSelecting,
  stopSelecting,
  pickedProjects,
  setPickedProjects,
  pickedCount,
  toggle,
  bulk,
  renderWorkspace,
  menuHandlers,
  projectActions,
  action,
  newChat,
  onProjectTerminal,
  terminals,
  shellNames,
  activeTerminalId,
  selectTerminal,
  shellActions,
  setWorkspaceDialog,
  setOperationId,
  setSettings,
}: {
  hidden: boolean;
  pending: boolean;
  state?: DesktopBootstrap;
  groups: { path: string; workspaces: TaskWorkspace[] }[];
  chats: TaskWorkspace[];
  collapsed: Record<string, boolean>;
  setCollapsed: Dispatch<Record<string, boolean>>;
  selecting: boolean;
  setSelecting: Dispatch<boolean>;
  stopSelecting(): void;
  pickedProjects: Set<string>;
  setPickedProjects: Dispatch<Set<string>>;
  pickedCount: number;
  toggle(set: Set<string>, value: string): Set<string>;
  bulk(kind: "archive" | "delete"): void;
  renderWorkspace(item: TaskWorkspace): React.JSX.Element;
  menuHandlers(label: string, actions: ContextAction[]): React.HTMLAttributes<HTMLElement>;
  projectActions(path: string): ContextAction[];
  action(operation: () => Promise<DesktopBootstrap | undefined>): Promise<void>;
  newChat(): void;
  onProjectTerminal(path: string): void;
  /** Plain shells (not agent terminals), listed under their project. */
  terminals: WorkspaceTerminal[];
  shellNames: Map<string, string>;
  activeTerminalId?: string;
  selectTerminal(terminal: WorkspaceTerminal): void;
  shellActions(terminal: WorkspaceTerminal): ContextAction[];
  setWorkspaceDialog(path: string): void;
  setOperationId(id: string): void;
  setSettings(open: boolean): void;
}): React.JSX.Element {
  return (
    <aside className="sidebar" aria-label="Workspaces" hidden={hidden}>
      <div className="sidebar-header" />
      {state?.workspaces.some((w) => w.pinned && !w.archivedAt && !w.removedAt) && (
        <section className="pinned-sessions" aria-label="Pinned workspaces">
          <div className="section-label sidebar-section-title">Pinned</div>
          {state.workspaces
            .filter((w) => w.pinned && !w.archivedAt && !w.removedAt)
            .map(renderWorkspace)}
        </section>
      )}
      <div className="section-label sidebar-section-title">
        <span>Projects</span>
        <Button
          variant="ghost"
          size="sm"
          className="select-toggle ml-auto mr-1 h-7 px-2 text-xs"
          aria-pressed={selecting}
          disabled={pending}
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          {selecting ? "Done" : "Select"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="icon-button size-[30px] rounded-md text-muted-foreground open-project-button"

          aria-label="Open project"
          title="Open project folder"
          disabled={pending}
          onClick={() => void action(() => window.kairo.openWorkspace())}
        >
          <Icon name="folder" />
        </Button>
      </div>
      <div className="project-session-list">
        {groups.map((group) => (
          <section className="project-session-group" key={group.path}>
            <div
              className="project-heading-row"
              {...menuHandlers(`${name(group.path)} project actions`, projectActions(group.path))}
            >
              {selecting && (
                <input
                  type="checkbox"
                  className="select-box"
                  aria-label={`Select project ${name(group.path)}`}
                  checked={pickedProjects.has(group.path)}
                  onChange={() => setPickedProjects((set) => toggle(set, group.path))}
                />
              )}
              <button
                className="project-heading"
                title={group.path}
                aria-expanded={!collapsed[group.path]}
                onClick={() => setCollapsed((all) => ({ ...all, [group.path]: !all[group.path] }))}
              >
                <Icon
                  name="chevron"
                  className={`transition-transform ${collapsed[group.path] ? "-rotate-90" : ""}`}
                />
                <Icon name="folder" />
                <span>{name(group.path)}</span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button project-terminal size-[30px] rounded-md text-muted-foreground"
                aria-label={`New terminal in ${name(group.path)}`}
                title="New terminal"
                disabled={pending}
                onClick={() => onProjectTerminal(group.path)}
              >
                <SquareTerminal />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button size-[30px] rounded-md text-muted-foreground project-add"

                aria-label={`New workspace in ${name(group.path)}`}
                title="New workspace"
                disabled={pending}
                onClick={() => setWorkspaceDialog(group.path)}
              >
                <Icon name="plus" />
              </Button>
            </div>
            <div hidden={collapsed[group.path]}>
              {group.workspaces.filter((item) => !item.pinned).map(renderWorkspace)}
              {terminals
                .filter((terminal) => group.workspaces.some((w) => w.id === terminal.workspaceId))
                .map((terminal) => {
                  const label = shellNames.get(terminal.id) ?? terminal.title;
                  const owner = group.workspaces.find((w) => w.id === terminal.workspaceId);
                  return (
                    <div
                      key={terminal.id}
                      data-terminal-id={terminal.id}
                      className="session-row terminal-row"
                      {...menuHandlers(`${label} actions`, shellActions(terminal))}
                    >
                      <button
                        className={`session ${activeTerminalId === terminal.id ? "selected" : ""}`}
                        aria-current={activeTerminalId === terminal.id ? "page" : undefined}
                        title={terminal.directory}
                        disabled={pending}
                        onClick={() => selectTerminal(terminal)}
                      >
                        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="session-labels">
                          <span className="session-title">{label}</span>
                        </span>
                        {terminal.state === "exited" ? (
                          <small className="session-agent">exited</small>
                        ) : (
                          group.workspaces.length > 1 &&
                          owner && (
                            <small className="session-agent">
                              {owner.name ?? owner.branch ?? "workspace"}
                            </small>
                          )
                        )}
                      </button>
                    </div>
                  );
                })}
              {state?.operations
                .filter(
                  (op) =>
                    op.repositoryPath === group.path && !op.workspaceId && op.phase !== "ready",
                )
                .map((op) => (
                  <button
                    key={op.id}
                    className="empty-session-list"
                    onClick={() => {
                      setOperationId(op.id);
                      setSettings(false);
                    }}
                  >
                    {op.name} · {op.phase}
                  </button>
                ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="empty-session-list">Open a project to get started</p>}
      </div>
      <section className="chat-section" aria-label="This computer">
        <div className="section-label sidebar-section-title">
          <span>This computer</span>
          <Button
            variant="ghost"
            size="icon"
            className="icon-button size-[30px] rounded-md text-muted-foreground "

            aria-label="New chat"
            title="New chat"
            disabled={pending}
            onClick={newChat}
          >
            <Icon name="plus" />
          </Button>
        </div>
        {chats.map(renderWorkspace)}
        {!chats.length && <p className="empty-session-list">No chats yet</p>}
      </section>
      {selecting && (
        <div className="bulk-bar" role="toolbar" aria-label="Selection actions">
          <span>{pickedCount ? `${pickedCount} selected` : "None selected"}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !pickedCount}
            onClick={() => bulk("archive")}
          >
            Archive
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || !pickedCount}
            onClick={() => bulk("delete")}
          >
            Delete
          </Button>
        </div>
      )}
      <Button
        variant="ghost"
        className="settings-link h-9 w-full justify-start px-2.5 font-normal text-muted-foreground"
        onClick={() => setSettings(true)}
      >
        <Icon name="settings" /> Settings
      </Button>
    </aside>
  );
}
