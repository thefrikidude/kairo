import React, { useEffect, useState } from "react";
import type { WorkspaceTerminal } from "../../shared/api.js";

/** Available even after every chat in a workspace has been archived or deleted. */
export function TerminalCatalog(): React.JSX.Element | null {
  const [items, setItems] = useState<WorkspaceTerminal[]>([]);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const offState = window.kairo.onTerminalState((info) =>
      setItems((all) => [...all.filter((item) => item.id !== info.id), info]),
    );
    const offClose = window.kairo.onTerminalClosed(({ id }) =>
      setItems((all) => all.filter((item) => item.id !== id)),
    );
    void window.kairo
      .listTerminals()
      .then((all) => {
        if (!cancelled) setItems(all);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => {
      cancelled = true;
      offState();
      offClose();
    };
  }, []);
  if (!items.length && !error) return null;
  return (
    <div className="terminal-catalog">
      <h3>Open terminals</h3>
      <p>
        Terminals stay with their workspace when a chat is archived or deleted. Close them before
        removing a worktree.
      </p>
      {error && (
        <p className="file-error" role="alert">
          {error}
        </p>
      )}
      {items.map((item) => (
        <article className="workspace-catalog-row" key={item.id}>
          <div>
            <strong>
              {item.title} · {item.state}
            </strong>
            <code>{item.directory}</code>
          </div>
          <button
            disabled={Boolean(closing)}
            onClick={() => {
              setError("");
              setClosing(item.id);
              void window.kairo
                .closeTerminal(item.id)
                .catch((cause) => setError((cause as Error).message))
                .finally(() => setClosing(undefined));
            }}
          >
            {closing === item.id ? "Closing…" : "Close terminal"}
          </button>
        </article>
      ))}
    </div>
  );
}
