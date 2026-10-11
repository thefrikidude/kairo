import { observeTerminalTheme, subscribeTerminalOutput } from "./terminal-resources.js";
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
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const observeResize = useRef<(active: boolean) => void>(() => {});
  const fit = useRef<() => void>(() => {});
  const terminal = useRef<Terminal | undefined>(undefined);
  useEffect(() => {
    const element = host.current!;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 1_000,
      screenReaderMode: visibleRef.current,
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
    const unsubscribe = subscribeTerminalOutput(info.id, receive);
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
            ["j", "p"].includes(event.key.toLowerCase()) ||
            (event.shiftKey && ["e", "d", "b", "n"].includes(event.key.toLowerCase())))
        ),
    );
    fit.current = () => {
      if (visibleRef.current && element.clientWidth && element.clientHeight) addon.fit();
    };
    const observer = new ResizeObserver(() => fit.current());
    observeResize.current = (active) => {
      observer.disconnect();
      if (active) observer.observe(element);
    };
    observeResize.current(visibleRef.current);
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
    const stopTheme = observeTerminalTheme(updateTheme);
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      stopTheme();
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
    observeResize.current(visible);
    if (terminal.current) terminal.current.options.screenReaderMode = visible;
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
