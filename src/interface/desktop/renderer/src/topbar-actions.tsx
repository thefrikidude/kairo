import React from "react";
import { Bot, FolderOpen, GitCompareArrows, SquareTerminal } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

type Tab = "files" | "changes";

/** Icon actions at the top right, like Claude's: new tabs on the left, workspace panels beside them. */
export function TopbarActions({
  canOpenTab,
  canOpenTerminal,
  canOpenPanel,
  panelTab,
  changeCount,
  onTerminal,
  onAgent,
  onPanel,
}: {
  canOpenTab: boolean;
  canOpenTerminal: boolean;
  canOpenPanel: boolean;
  /** The panel tab that is currently open, if any. */
  panelTab?: Tab;
  changeCount: number;
  onTerminal(): void;
  onAgent(): void;
  onPanel(tab: Tab): void;
}): React.JSX.Element {
  const icon = "size-8 rounded-md text-muted-foreground hover:text-foreground";
  return (
    <div className="topbar-actions ml-auto flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        aria-label="New terminal tab"
        title="New terminal"
        disabled={!canOpenTerminal}
        onClick={onTerminal}
      >
        <SquareTerminal />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={icon}
        aria-label="New agent tab"
        title="New agent"
        disabled={!canOpenTab}
        onClick={onAgent}
      >
        <Bot />
      </Button>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon"
        className={cn(icon, panelTab === "files" && "bg-accent text-foreground")}
        aria-label="Browse files"
        title="Files"
        aria-expanded={panelTab === "files"}
        disabled={!canOpenPanel}
        onClick={() => onPanel("files")}
      >
        <FolderOpen />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn("relative", icon, panelTab === "changes" && "bg-accent text-foreground")}
        aria-label="Review changes"
        title="Review"
        aria-expanded={panelTab === "changes"}
        disabled={!canOpenPanel}
        onClick={() => onPanel("changes")}
      >
        <GitCompareArrows />
        {changeCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground">
            {changeCount}
          </span>
        )}
      </Button>
    </div>
  );
}
