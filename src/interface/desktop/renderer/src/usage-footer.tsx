import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  selectUsageBucket,
  usageWindowLabel,
  type AgentUsage,
} from "../../../../domain/agent-usage.js";

const STALE_AFTER_MS = 5 * 60_000;
export function UsageFooter({
  sessionId,
  agentId,
  name,
  model,
}: {
  sessionId: string;
  agentId?: string;
  name: string;
  model?: string;
}) {
  const [snapshots, setSnapshots] = useState<Record<string, AgentUsage>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const latest = useRef(snapshots);
  latest.current = snapshots;
  const accept = useCallback((usage: AgentUsage) => {
    setSnapshots((current) => {
      if ((current[usage.agentId]?.revision ?? -1) > usage.revision) return current;
      return { ...current, [usage.agentId]: usage };
    });
    setErrors((current) => ({ ...current, [usage.agentId]: "" }));
    setNow(Date.now());
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (!agentId) return;
      try {
        accept(await window.kairo.readUsage(sessionId, force));
      } catch (error) {
        setErrors((current) => ({
          ...current,
          [agentId]: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [sessionId, agentId, accept],
  );

  useEffect(() => {
    const stopUsage = window.kairo.onUsage(accept);
    const stopError = window.kairo.onRuntimeError(() => {
      setSnapshots({});
      if (agentId)
        setErrors((current) => ({ ...current, [agentId]: "Agent service disconnected." }));
    });
    return () => {
      stopUsage();
      stopError();
    };
  }, [accept, agentId]);
  useEffect(() => {
    setOpen(false);
    void refresh();
    const onFocus = () => {
      setNow(Date.now());
      if (agentId && Date.now() - (latest.current[agentId]?.updatedAt ?? 0) >= 60_000)
        void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh, agentId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const usage = agentId ? snapshots[agentId] : undefined;
  const selected = usage ? selectUsageBucket(usage, model) : undefined;
  const expired = selected?.windows.some(
    (window) => window.resetsAt && window.resetsAt * 1000 <= now,
  );
  const error = (agentId ? errors[agentId] : undefined) || usage?.error;
  const stale =
    usage?.status === "stale" ||
    Boolean(error && usage?.updatedAt) ||
    Boolean(usage?.updatedAt && now - usage.updatedAt >= STALE_AFTER_MS) ||
    expired;
  const available = Boolean(selected?.windows.length);
  const loading = Boolean(agentId && !error && (!usage || usage.status === "loading"));
  const summary = available
    ? selected!.windows
        .map((window) => `${usageWindowLabel(window)} ${Math.round(window.remainingPercent)}%`)
        .join(" · ")
    : loading
      ? "Loading usage…"
      : "Usage unavailable";

  return (
    <footer className="agent-usage-footer" aria-label="Agent usage">
      <div ref={root} className="usage-control">
        <button
          ref={button}
          className="usage-indicator"
          aria-expanded={open}
          aria-controls="agent-usage-details"
          aria-haspopup="dialog"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && agentId && (stale || !usage)) void refresh();
          }}
        >
          <span className="usage-agent">{name}</span>
          <span className="usage-separator">·</span>
          {selected && selected.label.toLowerCase() !== name.toLowerCase() && (
            <>
              <span>{selected.label}</span>
              <span className="usage-separator">·</span>
            </>
          )}
          <span>
            {summary}
            {available ? " remaining" : ""}
          </span>
          {stale && available && <span className="usage-stale">Stale</span>}
          {loading && available && <span>Updating…</span>}
        </button>
        {open && (
          <section
            className="usage-popover"
            id="agent-usage-details"
            role="dialog"
            aria-label={`${name} usage limits`}
          >
            <div className="usage-popover-heading">
              <strong>{name} usage</strong>
              <button
                className="usage-close"
                aria-label="Close usage details"
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                }}
              >
                ×
              </button>
            </div>
            <p className="usage-account-note">
              {agentId
                ? "Account limits shared across chats."
                : "This provider does not expose account limits in Kairo."}
            </p>
            {usage?.buckets.map((bucket) => (
              <div className="usage-bucket" key={bucket.id}>
                <div className="usage-bucket-heading">
                  <strong>{bucket.label}</strong>
                  {bucket.id === selected?.id && <span>Current</span>}
                </div>
                {bucket.windows.length ? (
                  bucket.windows.map((window, index) => (
                    <div className="usage-window" key={index}>
                      <div>
                        <span>{usageWindowLabel(window)}</span>
                        <strong>{Math.round(window.remainingPercent)}% remaining</strong>
                      </div>
                      <meter
                        min={0}
                        max={100}
                        value={window.remainingPercent}
                        aria-label={`${bucket.label} ${usageWindowLabel(window)} remaining`}
                      />
                      <span className="usage-reset">
                        {window.resetsAt
                          ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                          : "Reset time unavailable"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>Usage unavailable for this quota.</p>
                )}
              </div>
            ))}
            {!usage?.buckets.length && (
              <p className="usage-empty">{loading ? "Loading usage…" : "Usage unavailable"}</p>
            )}
            {(stale || error) && (
              <p className="usage-notice" role="status">
                {error || "These values may be outdated. Refresh to check current limits."}
              </p>
            )}
            <div className="usage-popover-footer">
              <span>
                {usage?.updatedAt
                  ? `Updated ${new Date(usage.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "No usage snapshot"}
              </span>
              {agentId && (
                <button
                  className="usage-refresh"
                  disabled={loading}
                  onClick={() => void refresh(true)}
                >
                  Refresh
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </footer>
  );
}
