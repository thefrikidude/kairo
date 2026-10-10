import React, { memo, useEffect, useMemo, useState } from "react";
import { VirtualRows } from "./virtual-rows.js";
import parseDiff from "parse-diff";
import type { Task } from "../../shared/api.js";
import type {
  ReviewScope,
  WorkspaceReview,
} from "../../../../infrastructure/tools/workspace-review.js";

type Line = {
  kind: "add" | "remove" | "context" | "hunk" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
};
function rows(diff: string): Line[] {
  return parseDiff(diff).flatMap((file) =>
    file.chunks.flatMap((chunk): Line[] => [
      { kind: "hunk", text: chunk.content },
      ...chunk.changes.map((change): Line =>
        change.content.startsWith("\\")
          ? { kind: "meta", text: change.content }
          : change.type === "add"
            ? { kind: "add", text: change.content.slice(1), newLine: change.ln }
            : change.type === "del"
              ? { kind: "remove", text: change.content.slice(1), oldLine: change.ln }
              : {
                  kind: "context",
                  text: change.content.slice(1),
                  oldLine: change.ln1,
                  newLine: change.ln2,
                },
      ),
    ]),
  );
}
function Unified({ lines }: { lines: Line[] }): React.JSX.Element {
  return (
    <VirtualRows
      rows={lines}
      contentWidth={lines.reduce(
        (width, line) => Math.max(width, Math.min(line.text.length, 100_000) * 7.2 + 60),
        300,
      )}
      rowHeight={24}
      className="diff-scroll diff-rows"
      label="Unified diff"
      renderRow={(line) =>
        line.kind === "hunk" ? (
          <div className="diff-hunk">{line.text}</div>
        ) : (
          <div className={`diff-row diff-${line.kind}`}>
            <span className="diff-line-number">{line.oldLine ?? ""}</span>
            <span className="diff-line-number">{line.newLine ?? ""}</span>
            <span className="diff-marker">
              {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : ""}
            </span>
            <code>{line.text || " "}</code>
          </div>
        )
      }
    />
  );
}
function Split({ lines }: { lines: Line[] }): React.JSX.Element {
  const pairs: { old?: Line; next?: Line; label?: string }[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === "hunk" || line.kind === "meta") {
      pairs.push({ label: line.text });
      index += 1;
    } else if (line.kind === "context") {
      pairs.push({ old: line, next: line });
      index += 1;
    } else {
      const removed: Line[] = [],
        added: Line[] = [];
      while (lines[index]?.kind === "remove") removed.push(lines[index++]);
      while (lines[index]?.kind === "add") added.push(lines[index++]);
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1)
        pairs.push({ old: removed[offset], next: added[offset] });
    }
  }
  return (
    <>
      <div className="split-heading">
        <span>Before</span>
        <span>After</span>
      </div>
      <VirtualRows
        rows={pairs}
        contentWidth={
          lines.reduce(
            (width, line) => Math.max(width, Math.min(line.text.length, 100_000) * 7.2 + 60),
            270,
          ) * 2
        }
        rowHeight={24}
        className="diff-scroll split-diff"
        label="Split diff"
        renderRow={(pair) =>
          pair.label ? (
            <div className="diff-hunk">{pair.label}</div>
          ) : (
            <div className="split-diff-row">
              {[pair.old, pair.next].map((line, side) => (
                <div className={`split-diff-cell diff-${line?.kind ?? "blank"}`} key={side}>
                  <span className="diff-line-number">{side ? line?.newLine : line?.oldLine}</span>
                  <code>{line?.text || " "}</code>
                </div>
              ))}
            </div>
          )
        }
      />
    </>
  );
}

export default memo(function ReviewPanel({
  sessionId,
  overview,
  error,
  scope,
  canReviewTask,
  revision,
  task,
  onScope,
  onOpenFile,
}: {
  sessionId: string;
  overview?: WorkspaceReview;
  error: string;
  scope: ReviewScope;
  canReviewTask: boolean;
  revision: number;
  task?: Task;
  onScope(scope: ReviewScope): void;
  onOpenFile(path: string): void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string>();
  const [patch, setPatch] = useState<{ diff: string; unavailable?: string }>();
  const [patchError, setPatchError] = useState("");
  const [split, setSplit] = useState(false);
  const changes = overview?.changes ?? [];
  useEffect(() => {
    if (overview)
      setSelected((current) =>
        overview.changes.some((change) => change.path === current)
          ? current
          : overview.changes[0]?.path,
      );
  }, [overview]);
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
  }, [sessionId, selected, scope, revision]);
  const lines = useMemo(() => rows(patch?.diff ?? ""), [patch?.diff]);
  const files = useMemo(() => parseDiff(patch?.diff ?? ""), [patch?.diff]);
  const position = changes.findIndex((change) => change.path === selected);
  return (
    <section className="review-panel">
      <div className="review-scope">
        <select
          aria-label="Review scope"
          value={scope}
          onChange={(event) => onScope(event.target.value as ReviewScope)}
        >
          {canReviewTask && <option value="task">Task changes · since starting commit</option>}
          <option value="working">Working tree · staged and unstaged</option>
        </select>
        <small>
          {overview?.branch ?? "Git changes"}
          {overview?.baseCommit ? ` · ${overview.baseCommit.slice(0, 8)}` : ""}
        </small>
      </div>
      {task && (
        <details className="review-evidence">
          <summary>Agent result · {task.status.replaceAll("_", " ")}</summary>
          <p>{task.summary || task.error || task.prompt}</p>
          <p className={task.verificationPassed ? "addition-count" : ""}>
            {task.verificationPassed
              ? "Verification passed"
              : task.verificationPassed === false
                ? "Verification failed"
                : "Verification has not been confirmed"}
          </p>
          {task.verificationCommand && <code>{task.verificationCommand}</code>}
          {task.verificationOutput && <pre>{task.verificationOutput}</pre>}
        </details>
      )}
      {!overview && !error && (
        <p className="empty-small" role="status">
          Loading changes…
        </p>
      )}
      {(error || overview?.unavailable) && (
        <p className="file-error" role={error ? "alert" : "status"}>
          {error || overview?.unavailable}
        </p>
      )}
      <VirtualRows
        rows={changes}
        rowHeight={30}
        maxHeight={Math.min(changes.length * 30, 180)}
        keyboard
        label="Changed files"
        className="changed-file-navigation"
        renderRow={(change) => (
          <button
            className={`changed-file-button ${selected === change.path ? "active" : ""}`}
            title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            aria-pressed={selected === change.path}
            onClick={() => setSelected(change.path)}
          >
            <span
              className={`git-file-status ${/D/.test(change.status) ? "deletion-count" : "addition-count"}`}
            >
              {change.status.trim() || "M"}
            </span>
            <span>{change.path}</span>
          </button>
        )}
      />
      {overview && !error && !overview.unavailable && !changes.length && (
        <p className="empty-small">
          {scope === "task" ? "No changes since this task started" : "Working tree is clean"}
        </p>
      )}
      {selected && changes.some((change) => change.path === selected) && (
        <>
          <div className="selected-diff-toolbar">
            <button
              aria-label="Previous changed file"
              disabled={position <= 0}
              onClick={() => setSelected(changes[position - 1]?.path)}
            >
              ‹
            </button>
            <button
              aria-label="Next changed file"
              disabled={position >= changes.length - 1}
              onClick={() => setSelected(changes[position + 1]?.path)}
            >
              ›
            </button>
            <strong title={selected}>{selected}</strong>
            <span className="addition-count">
              +{files.reduce((sum, file) => sum + file.additions, 0)}
            </span>
            <span className="deletion-count">
              −{files.reduce((sum, file) => sum + file.deletions, 0)}
            </span>
            <button aria-pressed={split} onClick={() => setSplit((value) => !value)}>
              {split ? "Unified" : "Split"}
            </button>
            <button onClick={() => onOpenFile(selected)}>Open file</button>
          </div>
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
          {patch &&
            (lines.length ? (
              split ? (
                <Split lines={lines} />
              ) : (
                <Unified lines={lines} />
              )
            ) : (
              <pre className="file-preview diff-scroll">
                {patch.diff ||
                  "No text changes. Binary or submodule changes may require an external editor."}
              </pre>
            ))}
        </>
      )}
    </section>
  );
});
