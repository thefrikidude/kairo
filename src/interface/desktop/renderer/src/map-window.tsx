import React, { Suspense, lazy, useEffect, useState } from "react";
import type { ReviewScope } from "../../shared/api.js";

const MapPanel = lazy(() => import("./map-panel.js"));

export function isMapWindow(): boolean {
  return location.hash.startsWith("#map");
}

function storedTheme(): "light" | "dark" {
  let choice: string | null = null;
  try {
    choice = localStorage.getItem("kairo-theme");
  } catch {
    // Without storage the window simply follows the system theme.
  }
  if (choice === "light" || choice === "dark") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The change map in a window of its own; it shares the main window's backend and review marks. */
export function MapWindow(): React.JSX.Element {
  const params = new URLSearchParams(location.hash.replace(/^#map\??/, ""));
  const sessionId = params.get("session") ?? "";
  const workspaceId = params.get("workspace") ?? "";
  const canReviewTask = params.get("task") === "1";
  const [scope, setScope] = useState<ReviewScope>(
    canReviewTask && params.get("scope") === "task" ? "task" : "working",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = storedTheme();
  }, []);
  if (!sessionId || !workspaceId)
    return <p className="empty-small">This map window has no workspace to show.</p>;
  return (
    <div className="map-window">
      <Suspense fallback={<p className="empty-small">Loading map…</p>}>
        <MapPanel
          sessionId={sessionId}
          workspaceId={workspaceId}
          scope={scope}
          canReviewTask={canReviewTask}
          onScope={setScope}
          wide
        />
      </Suspense>
    </div>
  );
}
