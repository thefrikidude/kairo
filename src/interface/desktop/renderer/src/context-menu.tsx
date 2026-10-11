import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export type ContextAction = { label: string; disabled?: boolean; run(): void };
export type ContextMenuState = {
  x: number;
  y: number;
  trigger: HTMLElement;
  label: string;
  actions: ContextAction[];
};

/** A portal keeps row menus outside the sidebar's scrolling/clipping containers. */
export function ContextMenu({
  menu,
  close,
}: {
  menu: ContextMenuState;
  close(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const node = ref.current!;
    const bounds = node.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8)),
    });
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    const scroll = (event: Event) => {
      if (
        event.target === document ||
        (event.target instanceof Element && event.target.contains(menu.trigger))
      )
        close();
    };
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", scroll, true);
      if (menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
    };
  }, [menu, close]);
  return createPortal(
    <div
      ref={ref}
      className="row-context-menu"
      role="menu"
      aria-label={menu.label}
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        const items = Array.from(
          ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {menu.actions.map((action) => (
        <button
          role="menuitem"
          key={action.label}
          disabled={action.disabled}
          onClick={() => {
            close();
            action.run();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
