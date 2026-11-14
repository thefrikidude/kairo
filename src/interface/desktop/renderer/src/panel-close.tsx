import React from "react";
import { X } from "lucide-react";
import { Button } from "./components/ui/button.js";

/** Closes the right panel; each section puts it in its own top row so the panel needs no header. */
export function PanelClose({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 text-muted-foreground"
      aria-label="Close workspace panel"
      title="Close panel"
      onClick={onClose}
    >
      <X />
    </Button>
  );
}
