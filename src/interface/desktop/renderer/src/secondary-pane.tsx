import React from "react";
import { X } from "lucide-react";
import type { TaskWorkspace, WorkspaceTerminal } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import type { ContextAction } from "./context-menu.js";
import { navigateTabs } from "./tab-navigation.js";
import { WorkspaceTitle } from "./workspace-title.js";

/**
 * A pane beside the active one. It shows one tab at a time and is cheap to render; clicking
 * anywhere in it makes its workspace the active one, which then gets the full top bar.
 */
export function SecondaryPane({
  workspace,
  terminals,
  tabId,
  sidebarToggle,
  actions,
  onTab,
  onRename,
  onFocus,
  onClose,
  children,
}: {
  workspace?: TaskWorkspace;
  terminals: WorkspaceTerminal[];
  tabId?: string;
  /** The sidebar toggle belongs to the top-left pane only. */
  sidebarToggle?: React.ReactNode;
  actions?: ContextAction[];
  onTab(terminal: WorkspaceTerminal): void;
  onRename(title: string): void;
  onFocus(): void;
  onClose(): void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="pane pane-secondary flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`${workspace?.name ?? "Workspace"} pane`}
      onPointerDownCapture={onFocus}
    >
      <header className={`topbar ${sidebarToggle ? "topbar-first" : ""}`}>
        {sidebarToggle}
        <WorkspaceTitle
          name={workspace?.name ?? workspace?.branch ?? "Workspace"}
          actions={actions}
          disabled={!workspace || !!workspace.archivedAt}
          onRename={onRename}
        />
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label="Pane tabs"
          onKeyDown={navigateTabs}
        >
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              role="tab"
              aria-selected={terminal.id === tabId}
              tabIndex={terminal.id === tabId ? 0 : -1}
              title={terminal.directory}
              onClick={() => onTab(terminal)}
            >
              {terminal.title}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-8 shrink-0 rounded-md text-muted-foreground"
          aria-label="Close pane"
          title="Close pane"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {children}
    </section>
  );
}
