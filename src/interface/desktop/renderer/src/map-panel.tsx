import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapNode, ReviewScope, WorkspaceMap } from "../../shared/api.js";
import { rows, Unified } from "./review-panel.js";
import { buildGraph, fitGraph, frame, layoutGraph, type Point } from "./graph-layout.js";
import {
  churn,
  fingerprint,
  isContested,
  isLive,
  loadMarks,
  marksKey,
  nodeState,
  saveMarks,
  type ReviewMark,
  type StoredMark,
} from "./review-map.js";

/** Below this many files every label is drawn; beyond it only the ones that matter. */
const labelAllLimit = 30;
/** After a burst of writes every file is "just edited"; only the freshest few get the emphasis. */
const maxLive = 12;

export default memo(function MapPanel({
  sessionId,
  workspaceId,
  scope,
  canReviewTask,
  onScope,
  wide,
  expanded,
  onToggleExpand,
  onOpenWindow,
}: {
  sessionId: string;
  workspaceId: string;
  scope: ReviewScope;
  canReviewTask: boolean;
  onScope(scope: ReviewScope): void;
  /** Graph and diff sit side by side; set when the panel has the whole screen or its own window. */
  wide?: boolean;
  expanded?: boolean;
  onToggleExpand?(): void;
  onOpenWindow?(): Promise<void>;
}): React.JSX.Element {
  const [map, setMap] = useState<WorkspaceMap>();
  const [error, setError] = useState("");
  const [marks, setMarks] = useState(() => loadMarks(workspaceId));
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [onlyPending, setOnlyPending] = useState(true);
  const [patch, setPatch] = useState<{ diff: string; unavailable?: string }>();
  const [patchError, setPatchError] = useState("");
  const positions = useRef<Map<string, Point>>(new Map());
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const hasCanvas = !!map?.nodes.length;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setCanvasSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasCanvas]);

  useEffect(() => {
    let disposed = false,
      fetching = false;
    setMap(undefined);
    setError("");
    positions.current = new Map();
    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const value = await window.kairo.map(sessionId, scope);
        if (!disposed) {
          setMap(value);
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [sessionId, scope]);

  useEffect(() => {
    // Another window of the same workspace may approve or flag files; follow it.
    const sync = (event: StorageEvent) => {
      if (event.key === marksKey(workspaceId)) setMarks(loadMarks(workspaceId));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [workspaceId]);

  const nodes = useMemo(() => map?.nodes ?? [], [map]);
  const byPath = useMemo(() => new Map(nodes.map((node) => [node.path, node])), [nodes]);
  // Only the structure drives the layout, so polling that changes counts does not shuffle the graph.
  const structure = useMemo(
    () =>
      JSON.stringify([
        nodes.map((node) => node.path),
        (map?.links ?? []).map((link) => [link.from, link.to]),
      ]),
    [nodes, map?.links],
  );
  const { graph, placed, view } = useMemo(() => {
    const built = buildGraph(nodes, map?.links ?? []);
    const points = layoutGraph(built, positions.current);
    positions.current = points;
    return { graph: built, placed: points, view: frame(points.values()) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  const fit = useMemo(() => fitGraph(view, canvasSize), [view, canvasSize]);
  const spaced = (id: string): Point | undefined => {
    const point = placed.get(id);
    return point && { x: point.x * fit.spread, y: point.y * fit.spread };
  };
  const current = selected ? byPath.get(selected) : undefined;
  const currentFingerprint = current ? fingerprint(current) : undefined;
  const focus = selected ? `file:${selected}` : hovered;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (focus) {
      set.add(focus);
      for (const edge of graph.edges) {
        if (edge.source === focus) set.add(edge.target);
        if (edge.target === focus) set.add(edge.source);
      }
    }
    return set;
  }, [focus, graph]);

  useEffect(() => {
    if (selected && !byPath.has(selected) && map) setSelected(undefined);
  }, [byPath, map, selected]);
  useEffect(() => {
    let disposed = false;
    setPatch(undefined);
    setPatchError("");
    if (selected)
      void window.kairo
        .diff(sessionId, selected, scope)
        .then((value) => {
          if (!disposed) setPatch(value);
        })
        .catch((cause: Error) => {
          if (!disposed) setPatchError(cause.message);
        });
    return () => {
      disposed = true;
    };
    // The fingerprint changes when the agent edits the selected file, so the diff refreshes.
  }, [sessionId, selected, scope, currentFingerprint]);

  const mark = useCallback(
    (node: MapNode, value?: ReviewMark) => {
      setMarks((existing) => {
        const next: Record<string, StoredMark> = { ...existing };
        if (value) next[node.path] = { mark: value, fingerprint: fingerprint(node) };
        else delete next[node.path];
        saveMarks(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  const titles = useMemo(
    () => new Map((map?.sessions ?? []).map((item) => [item.id, item.title])),
    [map?.sessions],
  );
  const agentNames = (node: MapNode) =>
    (node.sessions ?? []).map((id) => titles.get(id) ?? "Agent");
  const liveSet = useMemo(
    () =>
      new Set(
        map
          ? nodes
              .filter((node) => isLive(node, map.now))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, maxLive)
              .map((node) => node.path)
          : [],
      ),
    [map, nodes],
  );
  const counts = { unreviewed: 0, approved: 0, flagged: 0, live: 0, contested: 0 };
  for (const node of nodes) {
    const state = nodeState(node, marks[node.path]);
    if (state === "approved") counts.approved += 1;
    else if (state === "flagged") counts.flagged += 1;
    else counts.unreviewed += 1;
    if (map && isLive(node, map.now)) counts.live += 1;
    if (isContested(node)) counts.contested += 1;
  }
  const lines = useMemo(() => rows(patch?.diff ?? ""), [patch?.diff]);
  const nextPending = () => {
    // Files two agents touched come first: they are the likeliest to hide a clobbered edit.
    const pending = nodes
      .filter((node) => {
        const state = nodeState(node, marks[node.path]);
        return state === "unreviewed" || state === "stale";
      })
      .sort((a, b) => Number(isContested(b)) - Number(isContested(a)));
    if (!pending.length) return;
    const at = pending.findIndex((node) => node.path === selected);
    setSelected(pending[(at + 1) % pending.length].path);
  };
  const importCount = graph.edges.filter((edge) => edge.kind === "import").length;
  const labelEveryFile = nodes.length <= labelAllLimit;

  return (
    <section className={`map-panel${wide ? " is-wide" : ""}`}>
      <div className="map-head">
        <div className="review-scope">
          <select
            aria-label="Review scope"
            value={scope}
            onChange={(event) => onScope(event.target.value as ReviewScope)}
          >
            {canReviewTask && <option value="task">Task changes · since starting commit</option>}
            <option value="working">Working tree · staged and unstaged</option>
          </select>
          <small>{map?.branch ?? "Git changes"}</small>
        </div>
        <div className="map-toolbar">
          <button aria-pressed={onlyPending} onClick={() => setOnlyPending((value) => !value)}>
            {onlyPending ? "Needs review" : "All changes"}
          </button>
          <span className="map-count">{counts.unreviewed} to review</span>
          <span className="map-count map-count-approved">{counts.approved} approved</span>
          <span className="map-count map-count-flagged">{counts.flagged} flagged</span>
          {counts.live > 0 && <span className="map-count map-count-live">{counts.live} live</span>}
          {counts.contested > 0 && (
            <span
              className="map-count map-count-contested"
              title="Changed while more than one agent was working"
            >
              {counts.contested} contested
            </span>
          )}
          <button className="map-next" disabled={!counts.unreviewed} onClick={nextPending}>
            Next ›
          </button>
          {onToggleExpand && (
            <button
              className="map-window-button"
              aria-pressed={expanded}
              title={expanded ? "Back to the side panel (Esc)" : "Fill the whole window"}
              onClick={onToggleExpand}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
          {onOpenWindow && (
            <button
              className="map-window-button"
              title="Open the map in its own window"
              onClick={() => void onOpenWindow().catch((cause: Error) => setError(cause.message))}
            >
              New window
            </button>
          )}
        </div>
        {error && (
          <p className="file-error" role="alert">
            {error}
          </p>
        )}
        {map?.unavailable && <p className="file-error">{map.unavailable}</p>}
        {map && !error && !map.unavailable && !nodes.length && (
          <p className="empty-small">
            {scope === "task" ? "No changes since this task started" : "Working tree is clean"}
          </p>
        )}
        {!map && !error && (
          <p className="empty-small" role="status">
            Loading map…
          </p>
        )}
      </div>
      <div className="map-body">
        {nodes.length > 0 && (
          <div className="map-canvas" ref={canvas}>
            <svg
              viewBox={`${fit.view.x} ${fit.view.y} ${fit.view.width} ${fit.view.height}`}
              preserveAspectRatio="xMidYMid meet"
              role="group"
              aria-label={`Change graph: ${nodes.length} changed files, ${importCount} import links`}
              onClick={() => setSelected(undefined)}
            >
              <g className="graph-edges">
                {graph.edges.map((edge) => {
                  const from = spaced(edge.source);
                  const to = spaced(edge.target);
                  if (!from || !to) return null;
                  const lit = focus && neighbours.has(edge.source) && neighbours.has(edge.target);
                  return (
                    <line
                      key={`${edge.kind}:${edge.source}>${edge.target}`}
                      className={`graph-edge is-${edge.kind}${lit ? " is-lit" : ""}${focus && !lit ? " is-faded" : ""}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                    />
                  );
                })}
              </g>
              <g>
                {graph.vertices.map((vertex) => {
                  const point = spaced(vertex.id);
                  if (!point) return null;
                  const faded = !!focus && !neighbours.has(vertex.id);
                  if (vertex.kind === "dir")
                    return (
                      <g
                        key={vertex.id}
                        className={`graph-dir${faded ? " is-faded" : ""}`}
                        transform={`translate(${point.x} ${point.y})`}
                      >
                        <circle r={vertex.path ? 4.5 : 6} />
                        {vertex.path && <text y={-9}>{vertex.label}</text>}
                      </g>
                    );
                  const node = byPath.get(vertex.path);
                  if (!node) return null;
                  const state = nodeState(node, marks[node.path]);
                  const live = liveSet.has(node.path);
                  const dim = onlyPending && state === "approved";
                  const radius = 6 + churn(node) * 11;
                  const chosen = selected === node.path;
                  const contested = isContested(node);
                  const showLabel =
                    labelEveryFile ||
                    chosen ||
                    hovered === vertex.id ||
                    live ||
                    neighbours.has(vertex.id);
                  return (
                    <g
                      key={vertex.id}
                      className={[
                        "graph-file",
                        `is-${state}`,
                        live && "is-live",
                        contested && "is-contested",
                        dim && "is-dim",
                        faded && "is-faded",
                        node.status.includes("D") && "is-deleted",
                        (node.status === "??" || node.status === "A") && "is-new",
                        chosen && "is-selected",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      transform={`translate(${point.x} ${point.y})`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={chosen}
                      aria-label={`${node.path}, ${node.additions} added, ${node.deletions} removed, ${state}${live ? ", edited just now" : ""}${contested ? `, contested by ${agentNames(node).join(" and ")}` : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected(node.path);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(node.path);
                        }
                      }}
                      onMouseEnter={() => setHovered(vertex.id)}
                      onMouseLeave={() => setHovered(undefined)}
                      onFocus={() => setHovered(vertex.id)}
                      onBlur={() => setHovered(undefined)}
                    >
                      <title>
                        {`${node.path}\n+${node.additions} −${node.deletions} · ${state}${
                          node.sessions?.length
                            ? `\nChanged while working: ${agentNames(node).join(", ")}`
                            : ""
                        }`}
                      </title>
                      {contested && <circle className="graph-contested" r={radius + 5} />}
                      {live && <circle className="graph-pulse" r={radius + 4} />}
                      <circle className="graph-dot" r={radius} />
                      {showLabel && <text y={radius + 11}>{vertex.label}</text>}
                    </g>
                  );
                })}
              </g>
            </svg>
            <div className="map-legend" aria-hidden="true">
              <span className="legend-dot is-unreviewed" /> to review
              <span className="legend-dot is-approved" /> approved
              <span className="legend-dot is-flagged" /> flagged
              <span className="legend-line" /> imports
              <span className="legend-ring" /> contested
            </div>
          </div>
        )}
        {current && (
          <div className="map-detail">
            <div className="selected-diff-toolbar">
              <strong title={current.path}>{current.path}</strong>
              <span className="addition-count">+{current.additions}</span>
              <span className="deletion-count">−{current.deletions}</span>
            </div>
            <div className="map-actions">
              <button
                className="map-approve"
                aria-pressed={nodeState(current, marks[current.path]) === "approved"}
                onClick={() => mark(current, "approved")}
              >
                Approve
              </button>
              <button
                className="map-flag"
                aria-pressed={nodeState(current, marks[current.path]) === "flagged"}
                onClick={() => mark(current, "flagged")}
              >
                Flag
              </button>
              {marks[current.path] && <button onClick={() => mark(current)}>Clear</button>}
              <button
                onClick={() =>
                  void window.kairo
                    .openInCursor(sessionId, current.path)
                    .catch((cause: Error) => setPatchError(cause.message))
                }
              >
                Open in Cursor
              </button>
            </div>
            {isContested(current) ? (
              <p className="map-contested" role="note">
                Changed while {agentNames(current).join(" and ")} were working. Either could have
                written it, or one may have overwritten the other. Review the combined result.
              </p>
            ) : (
              current.sessions?.length === 1 && (
                <p className="diff-notice">
                  Last changed while {agentNames(current)[0]} was working.
                </p>
              )
            )}
            {nodeState(current, marks[current.path]) === "stale" && (
              <p className="diff-notice">This file changed after you reviewed it.</p>
            )}
            {patchError && (
              <p className="file-error" role="alert">
                {patchError}
              </p>
            )}
            {!patch && !patchError && (
              <p className="empty-small" role="status">
                Loading diff…
              </p>
            )}
            {patch?.unavailable && <p className="diff-notice">{patch.unavailable}</p>}
            {patch && lines.length > 0 && <Unified lines={lines} />}
          </div>
        )}
      </div>
    </section>
  );
});
