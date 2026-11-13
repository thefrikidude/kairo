import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { Input } from "./components/ui/input.js";
import type { ContextAction } from "./context-menu.js";

/** The workspace name in the top bar: click it to rename in place, or open the menu beside it. */
export function WorkspaceTitle({
  name,
  actions,
  disabled,
  onRename,
}: {
  name: string;
  /** Without actions the title is plain text, for example while a workspace is still preparing. */
  actions?: ContextAction[];
  disabled?: boolean;
  onRename(title: string): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (!actions)
    return <strong className="workspace-heading max-w-[200px] truncate text-sm">{name}</strong>;

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== name) onRename(title);
  };
  if (editing)
    return (
      <Input
        ref={input}
        autoFocus
        aria-label="Workspace name"
        maxLength={200}
        className="h-8 w-48 text-sm font-semibold"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <div className="workspace-heading flex min-w-0 items-center">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 max-w-[180px] rounded-r-none px-2 text-sm font-semibold"
        disabled={disabled}
        title="Rename"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        <span className="truncate">{name}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-l-none rounded-r-md text-muted-foreground"
            aria-label="Workspace actions"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              onSelect={() => action.run()}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
