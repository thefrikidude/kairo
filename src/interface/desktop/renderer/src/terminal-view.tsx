import React, { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalData, WorkspaceTerminal } from "../../shared/api.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const TerminalView = memo(function TerminalView({
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
    if (terminal.current) terminal.current.options.disableStdin = info.state !== "running";
  }, [info.state]);
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
