import React, { useEffect, useState } from "react";
import type { DesktopBootstrap, TaskWorkspace } from "../../shared/api.js";
import { ModalFrame } from "./chrome.js";
export function WorkspacePalette({
  kind,
  state,
  workspace,
  select,
  file,
  close,
}: {
  kind: "jump" | "file";
  state: DesktopBootstrap;
  workspace?: TaskWorkspace;
  select(id: string, tab?: string): void;
  file(path: string): void;
  close(): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setIndex(0);
    setError("");
    if (kind !== "file" || !workspace || !query.trim()) {
      setPaths([]);
      setLoading(false);
      return;
    }
    let disposed = false;
    setPaths([]);
    setLoading(true);
    const timer = setTimeout(() => {
      void window.kairo
        .searchFiles(workspace.id, query)
        .then((result) => {
          if (!disposed) setPaths(result.paths);
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 120);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [kind, workspace?.id, query]);
  const rows: { id: string; label: string; detail: string; open(): void }[] =
    kind === "file"
      ? paths.map((path) => ({
          id: path,
          label: path.split("/").at(-1)!,
          detail: path,
          open: () => file(path),
        }))
      : state.workspaces
          .filter((w) => !w.archivedAt && !w.removedAt)
          .flatMap((w) => {
            const details = `${w.name} ${w.branch ?? ""} ${w.repositoryPath}`;
            return [
              {
                id: w.id,
                label: w.name ?? w.branch ?? w.directory,
                detail: w.branch ?? w.directory,
                open: () => select(w.id),
              },
              ...state.sessions
                .filter((s) => s.workspaceId === w.id)
                .map((s) => ({
                  id: s.id,
                  label: s.title,
                  detail: details,
                  open: () => select(w.id, `session:${s.id}`),
                })),
              ...state.terminals
                .filter((t) => t.workspaceId === w.id && !t.sessionId)
                .map((t, index) => ({
                  id: t.id,
                  label: `Terminal ${index + 1}`,
                  detail: details,
                  open: () => select(w.id, `terminal:${t.id}`),
                })),
            ];
          })
          .filter((row) => `${row.label} ${row.detail}`.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 100);
  return (
    <ModalFrame labelledBy="palette-title" blocked={false} onDismiss={close}>
      <div className="new-session-dialog workspace-palette">
        <h2 id="palette-title">
          {kind === "file" ? "Quick open file" : "Jump to workspace or tab"}
        </h2>
        <input
          autoFocus
          aria-label="Palette search"
          placeholder={kind === "file" ? "Search filenames…" : "Search projects, workspaces, tabs…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp"].includes(e.key)) {
              e.preventDefault();
              setIndex((i) =>
                Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))),
              );
            }
            if (e.key === "Enter" && rows[index]) {
              e.preventDefault();
              rows[index].open();
              close();
            }
          }}
        />
        <div className="palette-results" role="listbox" aria-label="Search results">
          {rows.map((row, i) => (
            <button
              key={row.id}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                row.open();
                close();
              }}
            >
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </button>
          ))}
        </div>
        {!rows.length && (
          <p className="empty-small">
            {loading
              ? "Searching…"
              : kind === "file" && !query
                ? "Type a filename to search this workspace."
                : "No matches"}
          </p>
        )}
        {error && (
          <p role="alert" className="file-error">
            {error}
          </p>
        )}
      </div>
    </ModalFrame>
  );
}
