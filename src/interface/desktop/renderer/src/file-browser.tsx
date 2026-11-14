import { PanelClose } from "./panel-close.js";
import { Input } from "./components/ui/input.js";
import React, { memo, useEffect, useRef, useState } from "react";
import type { WorkspaceEntry, FileSearch } from "../../shared/api.js";
import type { WorkspaceChange } from "../../../../infrastructure/tools/workspace-review.js";
import { VirtualRows } from "./virtual-rows.js";
import { CodePreview } from "./code-preview.js";

/** Lazy tree, explicit filename search and a read-only preview; editing happens in the user's editor. */
export default memo(function FileBrowser({
  sessionId,
  target,
  changes,
  revision,
  onClose,
}: {
  sessionId: string;
  target?: { path: string; nonce: number };
  changes: WorkspaceChange[];
  revision: number;
  onClose(): void;
}): React.JSX.Element {
  const [directories, setDirectories] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["."]));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<FileSearch>();
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<string>();
  const [reading, setReading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const readRevision = useRef(0);
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const treeRevision = useRef(-1);

  useEffect(() => {
    let disposed = false;
    const refresh = treeRevision.current !== revision;
    treeRevision.current = revision;
    const paths = [...expanded].filter((path) => refresh || !directoriesRef.current[path]);
    if (!paths.length) return;
    setLoading(true);
    void Promise.all(
      paths.map(async (path) => [path, await window.kairo.directory(sessionId, path)] as const),
    )
      .then((entries) => {
        if (!disposed)
          setDirectories((current) => ({ ...current, ...Object.fromEntries(entries) }));
      })
      .catch((cause: Error) => {
        if (!disposed) setError(cause.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, expanded, revision]);

  useEffect(() => {
    if (!query.trim()) {
      setSearch(undefined);
      return;
    }
    let disposed = false;
    setSearch(undefined);
    const timer = window.setTimeout(() => {
      void window.kairo
        .searchFiles(sessionId, query)
        .then((value) => {
          if (!disposed) setSearch(value);
        })
        .catch((cause: Error) => {
          if (!disposed) setError(cause.message);
        });
    }, 250);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, query, revision]);
  useEffect(
    () => () => {
      readRevision.current += 1;
    },
    [],
  );

  const preview = async (path: string, background = false) => {
    const current = ++readRevision.current;
    setSelected(path);
    setError("");
    if (!background) {
      setContent(undefined);
      setReading(true);
    }
    try {
      const value = await window.kairo.fileSnapshot(sessionId, path);
      if (current === readRevision.current) setContent(value.content);
    } catch (cause) {
      if (current === readRevision.current) {
        setContent(undefined);
        setError((cause as Error).message);
      }
    } finally {
      if (current === readRevision.current) setReading(false);
    }
  };
  useEffect(() => {
    if (target?.path) void preview(target.path);
  }, [target?.nonce]);
  useEffect(() => {
    if (selected) void preview(selected, true);
  }, [revision]);

  const treeRows: { entry: WorkspaceEntry; depth: number }[] = [];
  const collect = (path: string, depth = 0) => {
    for (const entry of directories[path] ?? []) {
      treeRows.push({ entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) collect(entry.path, depth + 1);
    }
  };
  collect(".");
  const visibleRows = query.trim()
    ? (search?.paths ?? []).map((path) => ({
        entry: { path, name: path, kind: "file" as const },
        depth: 0,
      }))
    : treeRows;

  return (
    <section className="file-browser" aria-label="Project files">
      {selected ? (
        <>
          <div className="file-preview-toolbar">
            <button
              onClick={() => {
                readRevision.current += 1;
                setSelected(undefined);
                setContent(undefined);
                setError("");
              }}
              aria-label="Back to files"
            >
              ← Files
            </button>
            <strong title={selected}>{selected}</strong>
            <button
              onClick={() =>
                void window.kairo
                  .openInCursor(sessionId, selected)
                  .catch((cause: Error) => setError(cause.message))
              }
            >
              Open in Cursor
            </button>
            <PanelClose onClose={onClose} />
          </div>
          {reading && (
            <p className="empty-small" role="status">
              Loading file…
            </p>
          )}
          {error && (
            <p className="file-error" role="alert">
              {error}
            </p>
          )}
          {content !== undefined && !reading && (
            <div className="file-preview-scroll" tabIndex={0} aria-label={`Preview of ${selected}`}>
              <CodePreview content={content} path={selected} />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="file-preview-toolbar">
            <strong>Project files</strong>
            <PanelClose onClose={onClose} />
          </div>
          <Input
            className="file-search m-3 w-auto"
            type="search"
            placeholder="Search file paths…"
            aria-label="Search project files"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
            }}
          />
          {error && (
            <p className="file-error" role="alert">
              {error}
            </p>
          )}
          {(loading || (query.trim() && !search)) && (
            <p className="empty-small" role="status">
              {query.trim() ? "Searching files…" : "Loading files…"}
            </p>
          )}
          <VirtualRows
            rows={visibleRows}
            rowHeight={32}
            keyboard
            className="file-entry-list"
            label="File tree"
            renderRow={({ entry, depth }) => (
              <button
                className="file-entry"
                data-file-path={entry.path}
                style={{ paddingLeft: `${10 + depth * 14}px` }}
                title={entry.path}
                onClick={() => {
                  if (entry.kind === "file") void preview(entry.path);
                  else
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    });
                }}
                aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined}
              >
                <span aria-hidden="true">
                  {entry.kind === "directory" ? (expanded.has(entry.path) ? "▾" : "▸") : "·"}
                </span>
                <span>{entry.name}</span>
                {changes.find((change) => change.path === entry.path) && (
                  <small className="git-file-status">
                    {changes.find((change) => change.path === entry.path)?.status.trim()}
                  </small>
                )}
              </button>
            )}
          />
          {query.trim() && search && !search.paths.length && (
            <p className="empty-small">No matching files</p>
          )}
          {search?.limited && (
            <p className="file-browser-note">
              Showing a bounded set of results. Narrow the search for more specific files.
            </p>
          )}
          {!query.trim() && !loading && !directories["."]?.length && !error && (
            <p className="empty-small">This folder is empty</p>
          )}
          <p className="file-browser-note">Dependencies and Git metadata are hidden.</p>
        </>
      )}
    </section>
  );
});
