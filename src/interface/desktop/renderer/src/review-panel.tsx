import { PanelClose } from "./panel-close.js";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles, type CodeViewItem, type FileDiffMetadata } from "@pierre/diffs";
import { Button } from "./components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { CodeView, type CodeViewReactOptions } from "@pierre/diffs/react";
import type {
  ReviewScope,
  WorkspaceReview,
} from "../../../../infrastructure/tools/workspace-review.js";

type Item = CodeViewItem<undefined>;
type Patch = { diff: string; unavailable?: string };
type Entry = { fileDiff?: FileDiffMetadata; note: string; version: number; diff: string };

/** Beyond this many changed files the list shows the rest by name only, to keep review snappy. */
const MAX_DIFFS = 200;
const FETCH_BATCH = 8;
const FILL_HEIGHT = { height: "100%" } as const;

function loadViewed(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function useThemeType(): "light" | "dark" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [type, setType] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setType(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return type;
}

function parseFile(diff: string): FileDiffMetadata | undefined {
  try {
    return parsePatchFiles(diff)[0]?.files[0];
  } catch {
    return undefined;
  }
}

const options: CodeViewReactOptions<undefined, undefined> = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  stickyHeaders: true,
  layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
};

export default memo(function ReviewPanel({
  sessionId,
  workspaceId,
  overview,
  error,
  scope,
  canReviewTask,
  revision,
  onScope,
  onClose,
}: {
  sessionId: string;
  workspaceId: string;
  overview?: WorkspaceReview;
  error: string;
  scope: ReviewScope;
  canReviewTask: boolean;
  revision: number;
  onScope(scope: ReviewScope): void;
  onClose(): void;
}): React.JSX.Element {
  const changes = overview?.changes ?? [];
  const viewedKey = `kairo.review.viewed:${workspaceId}:${scope}`;
  const [viewed, setViewed] = useState(() => loadViewed(viewedKey));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadViewed(viewedKey));
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(false);
  const [actionError, setActionError] = useState("");
  const versions = useRef(new Map<string, number>());

  useEffect(() => {
    const saved = loadViewed(viewedKey);
    setViewed(saved);
    setCollapsed(new Set(saved));
  }, [viewedKey]);

  const paths = changes.map((change) => change.path);
  const signature = paths.join("\0");
  useEffect(() => {
    let disposed = false;
    const wanted = signature ? signature.split("\0").slice(0, MAX_DIFFS) : [];
    setLoading(wanted.length > 0);
    void (async () => {
      const results: [string, Patch | Error][] = [];
      for (let start = 0; start < wanted.length && !disposed; start += FETCH_BATCH)
        results.push(
          ...(await Promise.all(
            wanted
              .slice(start, start + FETCH_BATCH)
              .map(async (path): Promise<[string, Patch | Error]> => {
                try {
                  return [path, await window.kairo.diff(sessionId, path, scope)];
                } catch (cause) {
                  return [path, cause instanceof Error ? cause : new Error(String(cause))];
                }
              }),
          )),
        );
      if (disposed) return;
      setEntries((previous) => {
        const next = new Map<string, Entry>();
        for (const [path, result] of results) {
          const old = previous.get(path);
          const diff = result instanceof Error ? "" : result.diff;
          const note = result instanceof Error ? result.message : (result.unavailable ?? "");
          if (old && old.diff === diff && old.note === note) {
            next.set(path, old);
            continue;
          }
          const version = (versions.current.get(path) ?? 0) + 1;
          versions.current.set(path, version);
          next.set(path, { fileDiff: diff ? parseFile(diff) : undefined, note, version, diff });
        }
        return next;
      });
      setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [sessionId, scope, signature, revision]);

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(viewedKey, JSON.stringify([...next]));
      } catch {
        /* the review still works without saved marks */
      }
    },
    [viewedKey],
  );
  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const toggleViewed = useCallback(
    (path: string) => {
      setViewed((current) => {
        const next = new Set(current);
        const marking = !next.delete(path);
        if (marking) next.add(path);
        persist(next);
        setCollapsed((open) => {
          const folded = new Set(open);
          if (marking) folded.add(path);
          else folded.delete(path);
          return folded;
        });
        return next;
      });
    },
    [persist],
  );

  const items = useMemo(() => {
    const result: Item[] = [];
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry?.fileDiff) continue;
      const fold = collapsed.has(path);
      result.push({
        id: path,
        type: "diff",
        fileDiff: entry.fileDiff,
        collapsed: fold,
        // Collapsing changes what is drawn, so it bumps the version along with new content.
        version: entry.version * 2 + (fold ? 1 : 0),
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, collapsed, signature]);
  const hidden = paths.filter((path) => !entries.get(path)?.fileDiff);
  const total = useMemo(() => {
    let add = 0,
      del = 0;
    for (const item of items)
      if (item.type === "diff")
        for (const hunk of item.fileDiff.hunks) {
          add += hunk.additionLines;
          del += hunk.deletionLines;
        }
    return { add, del };
  }, [items]);

  const themeType = useThemeType();
  const viewOptions = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      ...options,
      themeType,
      diffStyle: split ? "split" : "unified",
      diffIndicators: "bars",
    }),
    [split, themeType],
  );
  const renderHeaderPrefix = useCallback(
    (item: Item) => (
      <button
        className="review-chevron"
        aria-label={`${collapsed.has(item.id) ? "Expand" : "Collapse"} ${item.id}`}
        aria-expanded={!collapsed.has(item.id)}
        onClick={() => toggleCollapsed(item.id)}
      >
        {collapsed.has(item.id) ? "›" : "⌄"}
      </button>
    ),
    [collapsed, toggleCollapsed],
  );
  const renderHeaderMetadata = useCallback(
    (item: Item) => (
      <span className="review-file-actions">
        <button
          className={`review-viewed${viewed.has(item.id) ? " is-on" : ""}`}
          aria-pressed={viewed.has(item.id)}
          aria-label={`Mark ${item.id} as viewed`}
          title="Mark as viewed"
          onClick={() => toggleViewed(item.id)}
        >
          ✓
        </button>
        <button
          aria-label={`Open ${item.id} in Cursor`}
          title="Open in Cursor"
          onClick={() =>
            void window.kairo
              .openInCursor(sessionId, item.id)
              .then(() => setActionError(""))
              .catch((cause: Error) => setActionError(cause.message))
          }
        >
          ↗
        </button>
      </span>
    ),
    [viewed, toggleViewed, sessionId],
  );

  return (
    <section className="review-panel">
      <div className="review-scope">
        <div className="flex items-center gap-2">
          <Select value={scope} onValueChange={(value) => onScope(value as ReviewScope)}>
            <SelectTrigger
              aria-label="Review scope"
              className="h-9 w-full min-w-0 justify-between text-left text-[13px] [&>span]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {canReviewTask && (
                <SelectItem value="task" title="Everything changed since this task started">
                  Task changes
                </SelectItem>
              )}
              <SelectItem value="working" title="Staged and unstaged changes">
                Working tree
              </SelectItem>
            </SelectContent>
          </Select>
          <PanelClose onClose={onClose} />
        </div>
        <small>
          {overview?.branch ?? "Git changes"}
          {overview?.baseCommit ? ` · ${overview.baseCommit.slice(0, 8)}` : ""}
        </small>
      </div>
      {!overview && !error && (
        <p className="empty-small px-4 text-left" role="status">
          Loading changes…
        </p>
      )}
      {(error || overview?.unavailable) && (
        <p className="file-error" role={error ? "alert" : "status"}>
          {error || overview?.unavailable}
        </p>
      )}
      {actionError && (
        <p className="file-error" role="alert">
          {actionError}
        </p>
      )}
      {overview && !error && !overview.unavailable && !changes.length && (
        <p className="empty-small px-4 py-6 text-left text-[13px]">
          {scope === "task" ? "No changes since this task started" : "Working tree is clean"}
        </p>
      )}
      {changes.length > 0 && (
        <div className="review-summary">
          <strong>
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </strong>
          <span className="addition-count">+{total.add}</span>
          <span className="deletion-count">−{total.del}</span>
          <span className="review-spacer" />
          <small>
            {viewed.size ? `${[...viewed].filter((p) => paths.includes(p)).length} viewed` : ""}
          </small>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={split}
            onClick={() => setSplit((value) => !value)}
          >
            {split ? "Unified" : "Split"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() =>
              setCollapsed(collapsed.size >= items.length ? new Set() : new Set(paths))
            }
          >
            {collapsed.size >= items.length && items.length > 0 ? "Expand all" : "Collapse all"}
          </Button>
        </div>
      )}
      {loading && !items.length && (
        <p className="empty-small" role="status">
          Loading diffs…
        </p>
      )}
      {items.length > 0 && (
        <div className="review-diffs">
          <CodeView
            items={items}
            options={viewOptions}
            style={FILL_HEIGHT}
            renderHeaderPrefix={renderHeaderPrefix}
            renderHeaderMetadata={renderHeaderMetadata}
          />
        </div>
      )}
      {hidden.length > 0 && !loading && (
        <ul className="review-hidden" aria-label="Changes without a text diff">
          {hidden.map((path) => (
            <li key={path}>
              <code>{path}</code>
              <small>
                {entries.get(path)?.note ||
                  (entries.has(path)
                    ? "No text changes. Binary or submodule changes may need an external editor."
                    : `Not loaded: only the first ${MAX_DIFFS} files are shown.`)}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
