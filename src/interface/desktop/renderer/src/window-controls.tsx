import React from "react";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react";
import { Button } from "./components/ui/button.js";

/** Sidebar toggle and back/forward, pinned at the top left like Claude's desktop app. */
export function WindowControls({
  sidebarOpen,
  canBack,
  canForward,
  onToggle,
  onBack,
  onForward,
}: {
  sidebarOpen: boolean;
  canBack: boolean;
  canForward: boolean;
  onToggle(): void;
  onBack(): void;
  onForward(): void;
}): React.JSX.Element {
  const icon = "size-8 rounded-md text-muted-foreground hover:text-foreground";
  return (
    <div className="window-controls" role="toolbar" aria-label="Window navigation">
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        onClick={onToggle}
      >
        <PanelLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        aria-label="Back"
        title="Back"
        disabled={!canBack}
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        aria-label="Forward"
        title="Forward"
        disabled={!canForward}
        onClick={onForward}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
