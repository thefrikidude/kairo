import React, { useState } from "react";
import type { Edge } from "./pane-layout.js";
import { cn } from "./lib/utils.js";

export type DropZone = Edge | "center";

/** While a chat is being dragged, covers a pane with five drop targets and highlights the nearest. */
export function DropZones({
  active,
  onDrop,
}: {
  active: boolean;
  onDrop(zone: DropZone): void;
}): React.JSX.Element | null {
  const [zone, setZone] = useState<DropZone>();
  if (!active) return null;
  const locate = (event: React.DragEvent<HTMLDivElement>): DropZone => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    // The nearest edge wins once the pointer is in the outer quarter of the pane.
    const edges: [Edge, number][] = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ];
    const [edge, distance] = edges.reduce((best, item) => (item[1] < best[1] ? item : best));
    return distance < 0.25 ? edge : "center";
  };
  const shape: Record<DropZone, string> = {
    left: "inset-y-0 left-0 w-1/2",
    right: "inset-y-0 right-0 w-1/2",
    top: "inset-x-0 top-0 h-1/2",
    bottom: "inset-x-0 bottom-0 h-1/2",
    center: "inset-0",
  };
  return (
    <div
      className="drop-zones absolute inset-0 z-30"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setZone(locate(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(undefined);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const chosen = locate(event);
        setZone(undefined);
        onDrop(chosen);
      }}
    >
      {zone && (
        <div
          className={cn(
            "pointer-events-none absolute rounded-md border-2 border-ring bg-primary/15 transition-all",
            shape[zone],
          )}
        />
      )}
    </div>
  );
}
