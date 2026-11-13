import React, { useRef } from "react";
import { resize, type Leaf, type PaneNode } from "./pane-layout.js";
import { cn } from "./lib/utils.js";

/** Lays the pane tree out with draggable dividers. Each leaf is drawn by `renderLeaf`. */
export function SplitLayout({
  node,
  onResize,
  renderLeaf,
}: {
  node: PaneNode;
  onResize(next: (root: PaneNode) => PaneNode): void;
  renderLeaf(leaf: Leaf): React.ReactNode;
}): React.JSX.Element {
  if (node.type === "leaf") return <>{renderLeaf(node)}</>;
  return (
    <SplitView node={node} onResize={onResize}>
      {node.children.map((child) => (
        <SplitLayout key={child.id} node={child} onResize={onResize} renderLeaf={renderLeaf} />
      ))}
    </SplitView>
  );
}

function SplitView({
  node,
  onResize,
  children,
}: {
  node: Extract<PaneNode, { type: "split" }>;
  onResize(next: (root: PaneNode) => PaneNode): void;
  children: React.ReactNode[];
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const horizontal = node.direction === "row";
  const drag = (index: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds) return;
    const extent = horizontal ? bounds.width : bounds.height;
    let last = horizontal ? event.clientX : event.clientY;
    const move = (next: PointerEvent) => {
      const at = horizontal ? next.clientX : next.clientY;
      const delta = (at - last) / extent;
      last = at;
      onResize((root) => resize(root, node.id, index, delta));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("pane-resizing");
    };
    document.body.classList.add("pane-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <div
      ref={host}
      className={cn("pane-split flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}
    >
      {children.map((child, index) => (
        <React.Fragment key={(child as React.ReactElement).key}>
          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={{ flex: `${node.sizes[index]} 1 0%` }}
          >
            {child}
          </div>
          {index < children.length - 1 && (
            <div
              role="separator"
              aria-orientation={horizontal ? "vertical" : "horizontal"}
              className={cn(
                "pane-divider relative z-10 shrink-0 bg-border hover:bg-ring",
                horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
              )}
              onPointerDown={drag(index)}
            >
              <span
                className={cn(
                  "absolute",
                  horizontal ? "-inset-x-1.5 inset-y-0" : "-inset-y-1.5 inset-x-0",
                )}
              />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
