import React from "react";
import { Plus, X } from "lucide-react";
import type { WorkspaceTerminal } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import type { ContextAction } from "./context-menu.js";
import { navigateTabs } from "./tab-navigation.js";
import { cn } from "./lib/utils.js";

/**
 * The right panel's Terminal tab: this workspace's plain shells, one at a time. The live terminal
 * itself is laid over `slotRef` by the terminal layer, so switching tabs never restarts a shell.
 */
export function TerminalPanel({
  shells,
  labels,
  selectedId,
  slotRef,
  creating,
  onSelect,
  onAdd,
  onRename,
  onClose,
  menuHandlers,
  shellActions,
}: {
  shells: WorkspaceTerminal[];
  labels: Map<string, string>;
  selectedId?: string;
  slotRef(element: HTMLElement | null): void;
  creating: boolean;
  onSelect(terminal: WorkspaceTerminal): void;
  onAdd(): void;
  onRename(terminal: WorkspaceTerminal): void;
  onClose(terminal: WorkspaceTerminal): void;
  menuHandlers(label: string, actions: ContextAction[]): React.HTMLAttributes<HTMLElement>;
  shellActions(terminal: WorkspaceTerminal): ContextAction[];
}): React.JSX.Element {
  return (
    <div className="terminal-panel flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Terminals"
          onKeyDown={navigateTabs}
        >
          {shells.map((terminal) => {
            const label = labels.get(terminal.id) ?? terminal.title;
            const active = terminal.id === selectedId;
            return (
              <div
                key={terminal.id}
                data-terminal-id={terminal.id}
                className={cn(
                  "group flex shrink-0 items-center rounded-md text-sm",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                {...menuHandlers(`${label} actions`, shellActions(terminal))}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={`${terminal.directory}\nDouble-click to rename`}
                  className="max-w-40 truncate rounded-md px-2.5 py-1.5"
                  onClick={() => onSelect(terminal)}
                  onDoubleClick={() => onRename(terminal)}
                >
                  {label}
                </button>
                <button
                  aria-label={`Close ${label}`}
                  title="Close terminal"
                  className="mr-1 rounded p-0.5 opacity-0 hover:bg-background group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onClose(terminal)}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label="New terminal"
          title="New terminal"
          disabled={creating}
          onClick={onAdd}
        >
          <Plus />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1" ref={slotRef}>
        {!shells.length && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">No terminals in this workspace yet.</p>
            <Button variant="outline" size="sm" disabled={creating} onClick={onAdd}>
              New terminal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
