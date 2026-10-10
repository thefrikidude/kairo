import { navigateTabs } from "./tab-navigation.js";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalData, WorkspaceTerminal } from "../../shared/api.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const TerminalView = memo(function TerminalView({
  info,
  visible,
  onError,
}: {
  info: WorkspaceTerminal;
  visible: boolean;
  onError(error: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<() => void>(() => {});
  const terminal = useRef<Terminal | undefined>(undefined);
  useEffect(() => {
    const element = host.current!;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 1_000,
      screenReaderMode: true,
      allowProposedApi: false,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    let disposed = false;
    let attached = false;
    let sequence = -1;
    let queue: TerminalData[] = [];
    const fail = (error: unknown) => {
      if (!disposed) onError(message(error));
    };
    const write = (data: string, acknowledged?: number) =>
      term.write(data, () => {
        if (!disposed && acknowledged !== undefined)
          void window.kairo.acknowledgeTerminal(info.id, acknowledged).catch(fail);
      });
    const receive = (packet: TerminalData) => {
      if (packet.id !== info.id || packet.sequence <= sequence) return;
      if (!attached) {
        queue.push(packet);
        return;
      }
      sequence = packet.sequence;
      write(packet.data, packet.sequence);
    };
    const unsubscribe = window.kairo.onTerminalData(receive);
    void window.kairo
      .attachTerminal(info.id)
      .then((snapshot) => {
        if (disposed) return;
        sequence = snapshot.sequence;
        write(snapshot.buffer);
        attached = true;
        for (const packet of queue) receive(packet);
        queue = [];
        fit.current();
      })
      .catch(fail);
    const input = term.onData((data) => {
      for (let start = 0; start < data.length; start += 8_192)
        void window.kairo.writeTerminal(info.id, data.slice(start, start + 8_192)).catch(fail);
    });
    const resize = term.onResize(({ cols, rows }) => {
      void window.kairo
        .resizeTerminal(info.id, Math.min(500, Math.max(2, cols)), Math.min(200, Math.max(2, rows)))
        .catch(fail);
    });
    term.attachCustomKeyEventHandler(
      (event) =>
        !(
          (event.metaKey || event.ctrlKey) &&
          (event.code === "Backquote" ||
            (event.shiftKey && ["e", "d", "b"].includes(event.key.toLowerCase())))
        ),
    );
    fit.current = () => {
      if (element.clientWidth && element.clientHeight) addon.fit();
    };
    const observer = new ResizeObserver(() => fit.current());
    observer.observe(element);
    const updateTheme = () => {
      const colors = getComputedStyle(element);
      term.options.theme = {
        background: colors.getPropertyValue("--surface").trim() || "#151515",
        foreground: colors.getPropertyValue("--text").trim() || "#eee",
        cursor: colors.getPropertyValue("--text").trim() || "#eee",
        selectionBackground: "#64748b66",
      };
    };
    updateTheme();
    const themes = new MutationObserver(updateTheme);
    themes.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      themes.disconnect();
      input.dispose();
      resize.dispose();
      void window.kairo.detachTerminal(info.id).catch(() => {});
      terminal.current = undefined;
      term.dispose();
    };
  }, [info.id, onError]);
  useEffect(() => {
    if (visible) {
      fit.current();
      if (!(
        document.activeElement instanceof Element &&
        document.activeElement.closest('[role="tablist"]')
      ))
        terminal.current?.focus();
    }
  }, [visible]);
  return (
    <div
      className="terminal-view"
      role="tabpanel"
      id={`terminal-view-${info.id}`}
      aria-label={`${info.title} terminal`}
      hidden={!visible}
      ref={host}
    />
  );
});

export default memo(function TerminalPanel({
  workspaceId,
  visible,
  onHide,
}: {
  workspaceId: string;
  visible: boolean;
  onHide(): void;
}) {
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);
  const [active, setActive] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<string>();
  const [height, setHeight] = useState(240);
  const onError = useCallback((value: string) => setError(value), []);
  const upsert = useCallback(
    (info: WorkspaceTerminal) =>
      setTerminals((current) =>
        current.some((item) => item.id === info.id)
          ? current.map((item) => (item.id === info.id ? info : item))
          : [...current, info],
      ),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const offState = window.kairo.onTerminalState(upsert);
    const offClosed = window.kairo.onTerminalClosed(({ id }) =>
      setTerminals((current) => current.filter((item) => item.id !== id)),
    );
    void window.kairo
      .listTerminals()
      .then((items) => {
        if (!cancelled) setTerminals(items);
      })
      .catch((cause) => {
        if (!cancelled) onError(message(cause));
      });
    return () => {
      cancelled = true;
      offState();
      offClosed();
    };
  }, [upsert, onError]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setError("");
    void window.kairo
      .createTerminal(workspaceId, true)
      .then((info) => {
        if (!cancelled) {
          upsert(info);
          setActive((current) => ({ ...current, [workspaceId]: current[workspaceId] ?? info.id }));
        }
      })
      .catch((cause) => {
        if (!cancelled) onError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, visible, upsert, onError]);
  const current = terminals.filter((item) => item.workspaceId === workspaceId);
  const selected = current.find((item) => item.id === active[workspaceId]) ?? current[0];
  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const info = await window.kairo.createTerminal(workspaceId);
      upsert(info);
      setActive((all) => ({ ...all, [workspaceId]: info.id }));
    } catch (cause) {
      onError(message(cause));
    } finally {
      setCreating(false);
    }
  };
  const close = async (id: string) => {
    if (closing) return;
    setClosing(id);
    setError("");
    try {
      await window.kairo.closeTerminal(id);
    } catch (cause) {
      onError(message(cause));
    } finally {
      setClosing(undefined);
    }
  };
  return (
    <section
      className="terminal-panel"
      id="terminal-panel"
      aria-label="Workspace terminal"
      hidden={!visible}
      style={{ height }}
    >
      <div
        className="terminal-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={140}
        aria-valuemax={500}
        aria-valuenow={height}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setHeight((value) =>
              Math.max(140, Math.min(500, value + (event.key === "ArrowUp" ? 20 : -20))),
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const target = event.currentTarget;
          const start = event.clientY;
          const initial = height;
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) =>
            setHeight(Math.max(140, Math.min(500, initial + start - next.clientY)));
          const end = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", end);
            target.removeEventListener("pointercancel", end);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", end);
          target.addEventListener("pointercancel", end);
        }}
      />
      <div className="terminal-toolbar">
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label="Terminal tabs"
          onKeyDown={navigateTabs}
        >
          {current.map((info, index) => (
            <div className="terminal-tab" key={info.id}>
              <button
                role="tab"
                tabIndex={selected?.id === info.id ? 0 : -1}
                aria-selected={selected?.id === info.id}
                aria-controls={`terminal-view-${info.id}`}
                title={info.directory}
                onClick={() => setActive((all) => ({ ...all, [workspaceId]: info.id }))}
              >
                {info.title} {index + 1}
                {info.state === "exited" ? ` · exited ${info.exitCode ?? ""}` : ""}
              </button>
              <button
                aria-label={`Close terminal ${index + 1}`}
                tabIndex={selected?.id === info.id ? 0 : -1}
                title="Stop shell and close terminal"
                disabled={Boolean(closing)}
                onClick={() => void close(info.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          aria-label="New terminal"
          title="New terminal in this workspace"
          disabled={creating}
          onClick={() => void create()}
        >
          +
        </button>
        <button aria-label="Hide terminal" title="Hide terminal (Cmd/Ctrl+`)" onClick={onHide}>
          ⌄
        </button>
      </div>
      <div className="terminal-directory" title={selected?.directory}>
        {selected?.directory ?? "Opening a shell in this workspace…"}
      </div>
      {error && (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      )}
      {terminals.map((info) => (
        <TerminalView
          key={info.id}
          info={info}
          visible={visible && selected?.id === info.id}
          onError={onError}
        />
      ))}
      {!current.length && (
        <div className="terminal-empty">
          {error ? (
            <button onClick={() => void create()}>Try again</button>
          ) : (
            "No terminals in this workspace. Use + to open one."
          )}
        </div>
      )}
    </section>
  );
});
