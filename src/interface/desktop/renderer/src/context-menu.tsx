import React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";

export type ContextAction = { label: string; disabled?: boolean; run(): void };
export type ContextMenuState = {
  x: number;
  y: number;
  trigger: HTMLElement;
  label: string;
  actions: ContextAction[];
};

/**
 * Row menus open at a pointer position, so a zero-size fixed anchor stands in for the trigger.
 * Radix portals the content out of the sidebar's clipping containers and keeps it on screen.
 */
export function ContextMenu({
  menu,
  close,
}: {
  menu: ContextMenuState;
  close(): void;
}): React.JSX.Element {
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => !open && close()}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        aria-label={menu.label}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A chosen action may have opened a dialog that already took focus; leave it there.
          if (menu.trigger.isConnected && !document.querySelector("[role=dialog]"))
            menu.trigger.focus({ preventScroll: true });
        }}
      >
        {menu.actions.map((action) => (
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
  );
}
