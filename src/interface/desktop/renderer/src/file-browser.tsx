import React, { useEffect, useRef, useState } from "react";
import type { WorkspaceEntry } from "../../shared/api.js";

/** Mounted only when Files is opened; each directory is fetched on demand. */
export default function FileBrowser({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [directory, setDirectory] = useState(".");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const readRevision = useRef(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    setEntries([]);
    setQuery("");
    void window.kairo
      .directory(sessionId, directory)
      .then((value) => {
        if (!disposed) setEntries(value);
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
  }, [sessionId, directory, revision]);

  useEffect(
    () => () => {
      readRevision.current += 1;
    },
    [],
  );

  const preview = async (path: string) => {
    const current = ++readRevision.current;
    setSelected(path);
    setContent(undefined);
    setReading(true);
    setError("");
    try {
      const value = await window.kairo.readFile(sessionId, path);
      if (current === readRevision.current) setContent(value);
    } catch (cause) {
      if (current === readRevision.current) setError((cause as Error).message);
    } finally {
      if (current === readRevision.current) setReading(false);
    }
  };

  const closePreview = () => {
    readRevision.current += 1;
    setSelected(undefined);
    setContent(undefined);
    setReading(false);
    setError("");
  };

  return (
    <section className="file-browser" aria-label="Project files">
      {selected ? (
        <>
          <div className="file-preview-toolbar">
            <button onClick={closePreview} aria-label="Back to files">
              ← Files
            </button>
            <strong title={selected}>{selected}</strong>
            <button
              aria-label="Reload file preview"
              disabled={reading}
              onClick={() => void preview(selected)}
            >
              ↻
            </button>
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
          {content !== undefined && (
            <div className="file-preview-scroll" tabIndex={0} aria-label={`Preview of ${selected}`}>
              <pre className="file-preview">
                <code>{content || "(empty file)"}</code>
              </pre>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="file-preview-toolbar">
            <button
              disabled={directory === "."}
              aria-label="Parent folder"
              onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/") || ".")}
            >
              ↑
            </button>
            <strong title={directory}>{directory === "." ? "Project files" : directory}</strong>
            <button
              aria-label="Refresh files"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              ↻
            </button>
          </div>
          <input
            className="file-search"
            type="search"
            placeholder="Filter this folder…"
            aria-label="Filter files in this folder"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading && (
            <p className="empty-small" role="status">
              Loading files…
            </p>
          )}
          {error && (
            <p className="file-error" role="alert">
              {error}
            </p>
          )}
          <div className="file-entry-list">
            {entries
              .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
              .map((entry) => (
                <button
                  className="file-entry"
                  key={entry.path}
                  title={entry.path}
                  onClick={() =>
                    entry.kind === "directory" ? setDirectory(entry.path) : void preview(entry.path)
                  }
                >
                  <span aria-hidden="true">{entry.kind === "directory" ? "▸" : "·"}</span>
                  <span>{entry.name}</span>
                  {entry.kind === "directory" && <small>folder</small>}
                </button>
              ))}
            {!loading &&
              !error &&
              !entries.some((entry) => entry.name.toLowerCase().includes(query.toLowerCase())) && (
                <p className="empty-small">
                  {query ? "No matching files in this folder" : "This folder is empty"}
                </p>
              )}
          </div>
          <p className="file-browser-note">Dependencies and Git metadata are hidden.</p>
        </>
      )}
    </section>
  );
}
