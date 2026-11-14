import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Eraser, Plus, X } from "lucide-react";
import type { WorkspaceTerminal } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { PanelClose } from "./panel-close.js";
import { terminalControls } from "./terminal-resources.js";
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
  onClosePanel,
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
  onClosePanel(): void;
}): React.JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const watcher = new ResizeObserver(() => setWidth(node.clientWidth));
    watcher.observe(node);
    setWidth(node.clientWidth);
    return () => watcher.disconnect();
  }, []);
  // Roughly what the + , clear and close buttons need, and what one tab needs before it truncates.
  const room = width - 120;
  const collapsed =
    shells.length > 0 && room < Math.min(shells.length, 2) * 118 + (shells.length > 2 ? 60 : 0);
  const selected = shells.find((terminal) => terminal.id === selectedId);
  const labelOf = (terminal: WorkspaceTerminal) => labels.get(terminal.id) ?? terminal.title;

  const tab = (terminal: WorkspaceTerminal) => {
    const label = labelOf(terminal);
    const active = terminal.id === selectedId;
    return (
      <div
        key={terminal.id}
        data-terminal-id={terminal.id}
        className={cn(
          "group flex shrink-0 items-center rounded-md text-sm",
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
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
          className={cn(
            "mr-1 rounded p-0.5 hover:bg-background focus-visible:opacity-100",
            active && collapsed ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          onClick={() => onClose(terminal)}
        >
          <X className="size-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="terminal-panel flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div
          ref={strip}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Terminals"
          onKeyDown={navigateTabs}
        >
          {collapsed ? (
            <>
              {selected && tab(selected)}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground"
                    aria-label="All terminals"
                    title="All terminals"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48">
                  {shells.map((terminal) => (
                    <DropdownMenuItem
                      key={terminal.id}
                      className={cn(terminal.id === selectedId && "bg-accent")}
                      onSelect={() => onSelect(terminal)}
                    >
                      <span className="min-w-0 flex-1 truncate">{labelOf(terminal)}</span>
                      <button
                        aria-label={`Close ${labelOf(terminal)}`}
                        className="ml-3 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(terminal);
                        }}
                      >
                        <X className="size-3.5" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            shells.map(tab)
          )}
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
        {selected && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="Clear terminal"
            title="Clear terminal"
            onClick={() => {
              terminalControls(selected.id)?.clear();
              terminalControls(selected.id)?.focus();
            }}
          >
            <Eraser />
          </Button>
        )}
        <PanelClose onClose={onClosePanel} />
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
