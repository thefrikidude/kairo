import React, { useEffect, useRef, useState } from "react";
import { ZoomIn } from "lucide-react";
import { Button } from "./components/ui/button.js";

/** A brief "110% · Reset" pill after the page zoom changes, like Claude's desktop app. */
export function ZoomIndicator(): React.JSX.Element | null {
  const [percent, setPercent] = useState(100);
  const [shown, setShown] = useState(false);
  const hovered = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (hovered.current) schedule();
      else setShown(false);
    }, 2500);
  };
  useEffect(() => {
    const stop = window.kairo.onZoom((next) => {
      setPercent(next);
      setShown(true);
      schedule();
    });
    return () => {
      stop();
      window.clearTimeout(timer.current);
    };
  }, []);

  if (!shown) return null;
  return (
    <div
      className="zoom-indicator"
      role="status"
      aria-label={`Zoom ${percent}%`}
      // Counter the page zoom so the pill stays the same size it would at 100%.
      style={{ zoom: 100 / percent }}
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => {
        hovered.current = false;
        schedule();
      }}
    >
      <ZoomIn className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="tabular-nums">{percent}%</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 bg-accent px-2.5 text-xs"
        onClick={() => void window.kairo.resetZoom()}
      >
        Reset
      </Button>
    </div>
  );
}
