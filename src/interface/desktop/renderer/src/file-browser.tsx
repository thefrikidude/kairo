import React, { memo, useEffect, useRef, useState } from "react";
import type { WorkspaceEntry, FileSearch } from "../../shared/api.js";
import type { WorkspaceChange } from "../../../../infrastructure/tools/workspace-review.js";
import { VirtualRows } from "./virtual-rows.js";
import { CodePreview } from "./code-preview.js";
import { bufferContent, editorBuffer, type EditorBuffer } from "./editor-buffer.js";

/** Lazy tree, explicit filename search and small editor buffers owned above session navigation. */
export default memo(function FileBrowser({
  sessionId,
  busy,
  buffers,
  target,
  changes,
  revision,
  onBuffer,
  onSaved,
}: {
  sessionId: string;
  busy: boolean;
  buffers: Record<string, EditorBuffer>;
  target?: { path: string; nonce: number };
  changes: WorkspaceChange[];
  revision: number;
  onBuffer(path: string, buffer: EditorBuffer): void;
  onSaved(): void;
}): React.JSX.Element {
  const [directories, setDirectories] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["."]));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<FileSearch>();
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const readRevision = useRef(0);
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const treeRevision = useRef(-1);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const buffer = selected ? buffers[selected] : undefined;
  const dirty = !!buffer && buffer.draft !== buffer.saved;

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

  const preview = async (path: string, force = false, preserveEditing = false) => {
    const current = ++readRevision.current;
    setSelected(path);
    if (!preserveEditing) setEditing(false);
    setError("");
    if (!force && buffersRef.current[path]?.draft !== buffersRef.current[path]?.saved) {
      setReading(false);
      return;
    }
    setReading(true);
    try {
      const value = await window.kairo.fileSnapshot(sessionId, path);
      if (current === readRevision.current) onBuffer(path, editorBuffer(value));
    } catch (cause) {
      if (current === readRevision.current) setError((cause as Error).message);
    } finally {
      if (current === readRevision.current) setReading(false);
    }
  };
  useEffect(() => {
    if (target?.path) void preview(target.path);
  }, [target?.nonce]);
  useEffect(() => {
    if (selected && !dirty && !saving) void preview(selected, false, true);
  }, [revision]);

  const save = async () => {
    if (!selected || !buffer || !dirty || saving || busy) return;
    setSaving(true);
    setError("");
    try {
      const result = await window.kairo.saveFile(
        sessionId,
        selected,
        bufferContent(buffer),
        buffer.revision,
      );
      onBuffer(selected, editorBuffer(result));
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
                setError("");
              }}
              aria-label="Back to files"
            >
              ← Files
            </button>
            <strong title={selected}>
              {selected}
              {dirty ? " ●" : ""}
            </strong>
            <button
              aria-label="Reload file preview"
              disabled={reading || saving}
              onClick={() => (dirty ? setReloadPrompt(true) : void preview(selected, true))}
            >
              ↻
            </button>
            {error && (
              <button
                onClick={() =>
                  void window.kairo
                    .openInCursor(sessionId, selected)
                    .catch((cause: Error) => setError(cause.message))
                }
              >
                Open in Cursor
              </button>
            )}
          </div>
          <div className="file-editor-actions">
            <button
              disabled={!buffer || reading || saving}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Preview" : "Edit"}
            </button>
            <span role="status">
              {dirty
                ? "Unsaved changes"
                : reading
                  ? "Loading…"
                  : buffer
                    ? "Saved"
                    : "Preview unavailable"}
            </span>
            {editing && (
              <button
                className="primary"
                disabled={!dirty || reading || saving || busy}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            {busy && <small>Save after the agent stops</small>}
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
          {buffer &&
            !reading &&
            (editing ? (
              <textarea
                className="code-editor"
                aria-label={`Edit ${selected}`}
                spellCheck={false}
                autoFocus
                value={buffer.draft}
                disabled={saving}
                onChange={(event) => onBuffer(selected, { ...buffer, draft: event.target.value })}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
            ) : (
              <div
                className="file-preview-scroll"
                tabIndex={0}
                aria-label={`Preview of ${selected}`}
              >
                <CodePreview content={buffer.draft} path={selected} />
              </div>
            ))}
        </>
      ) : (
        <>
          <div className="file-preview-toolbar">
            <strong>Project files</strong>
            <button aria-label="Refresh files" disabled={loading} onClick={onSaved}>
              ↻
            </button>
          </div>
          <input
            className="file-search"
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
                {buffers[entry.path]?.draft !== buffers[entry.path]?.saved && (
                  <small title="Unsaved edits">●</small>
                )}
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
          {Object.entries(buffers).some(([, value]) => value.draft !== value.saved) && (
            <div className="unsaved-files">
              <small>Unsaved files</small>
              {Object.entries(buffers)
                .filter(([, value]) => value.draft !== value.saved)
                .map(([path]) => (
                  <button
                    key={path}
                    onClick={() => {
                      void preview(path);
                      setEditing(true);
                    }}
                  >
                    ● {path}
                  </button>
                ))}
            </div>
          )}
          <p className="file-browser-note">Dependencies and Git metadata are hidden.</p>
        </>
      )}
      {reloadPrompt && (
        <div className="inline-confirm" role="alertdialog" aria-label="Discard unsaved edits?">
          <p>Reloading will discard your unsaved edits to this file.</p>
          <button onClick={() => setReloadPrompt(false)}>Keep editing</button>
          <button
            onClick={() => {
              setReloadPrompt(false);
              if (selected) void preview(selected, true);
            }}
          >
            Discard and reload
          </button>
        </div>
      )}
    </section>
  );
});
