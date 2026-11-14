import React, { useState } from "react";
import { Plus, Search } from "lucide-react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { Icon } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import type { ContextAction } from "./context-menu.js";

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

type Dispatch<T> = React.Dispatch<React.SetStateAction<T>>;
type SectionId = "pinned" | "projects" | "chats";

const storageKey = "kairo.sidebar.sections";
function loadClosed(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** A sidebar section whose title toggles it open and closed. */
function Section({
  id,
  title,
  open,
  onToggle,
  action,
  children,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  onToggle(id: SectionId): void;
  /** A button shown at the right of the title, for example to add an item. */
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`sidebar-section sidebar-section-${id}`} aria-label={title}>
      <div className="section-header">
        <button className="section-toggle" aria-expanded={open} onClick={() => onToggle(id)}>
          <span>{title}</span>
          <Icon name="chevron" className={`transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        {action}
      </div>
      <div hidden={!open}>{children}</div>
    </section>
  );
}

export function Sidebar({
  hidden,
  pending,
  state,
  groups,
  chats,
  collapsed,
  setCollapsed,
  renderWorkspace,
  menuHandlers,
  projectActions,
  action,
  newChat,
  createChat,
  onSearch,
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
  renderWorkspace(item: TaskWorkspace): React.JSX.Element;
  menuHandlers(label: string, actions: ContextAction[]): React.HTMLAttributes<HTMLElement>;
  projectActions(path: string): ContextAction[];
  action(operation: () => Promise<DesktopBootstrap | undefined>): Promise<void>;
  newChat(): void;
  /** Starts a chat on this computer right away. */
  createChat(): void;
  onSearch(): void;
  setWorkspaceDialog(path: string): void;
  setOperationId(id: string): void;
  setSettings(open: boolean): void;
}): React.JSX.Element {
  const [closed, setClosed] = useState(loadClosed);
  const toggleSection = (id: SectionId) =>
    setClosed((all) => {
      const next = { ...all, [id]: !all[id] };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* the sections still toggle without saved state */
      }
      return next;
    });
  const pinned = (state?.workspaces ?? []).filter((w) => w.pinned && !w.archivedAt && !w.removedAt);
  const row =
    "sidebar-nav-row h-9 w-full justify-start gap-3 px-2.5 text-sm font-normal text-foreground";
  return (
    <aside className="sidebar" aria-label="Workspaces" hidden={hidden}>
      <div className="sidebar-header" />
      <nav className="sidebar-nav" aria-label="Quick actions">
        <Button variant="ghost" className={row} disabled={pending} onClick={newChat}>
          <Plus /> New
        </Button>
        <Button variant="ghost" className={row} onClick={onSearch}>
          <Search /> Search
        </Button>
      </nav>
      {pinned.length > 0 && (
        <Section id="pinned" title="Pinned" open={!closed.pinned} onToggle={toggleSection}>
          {pinned.map(renderWorkspace)}
        </Section>
      )}
      <Section id="projects" title="Projects" open={!closed.projects} onToggle={toggleSection}>
        <div className="project-session-list">
          {groups.map((group) => (
            <section className="project-session-group" key={group.path}>
              <div
                className="project-heading-row"
                {...menuHandlers(`${name(group.path)} project actions`, projectActions(group.path))}
              >
                <button
                  className="project-heading"
                  title={group.path}
                  aria-expanded={!collapsed[group.path]}
                  onClick={() =>
                    setCollapsed((all) => ({ ...all, [group.path]: !all[group.path] }))
                  }
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
          {!groups.length && (
            <button
              className="empty-session-list"
              disabled={pending}
              onClick={() => void action(() => window.kairo.openWorkspace())}
            >
              Open a project to get started
            </button>
          )}
        </div>
      </Section>
      <Section
        id="chats"
        title="This computer"
        open={!closed.chats}
        onToggle={toggleSection}
        action={
          <Button
            variant="ghost"
            size="icon"
            className="icon-button size-[26px] rounded-md text-muted-foreground"
            aria-label="New chat"
            title="New chat on this computer"
            disabled={pending}
            onClick={createChat}
          >
            <Icon name="plus" />
          </Button>
        }
      >
        {chats.map(renderWorkspace)}
        {!chats.length && <p className="empty-session-list">No chats yet</p>}
      </Section>
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
