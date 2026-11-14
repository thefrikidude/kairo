import {
  observeTerminalTheme,
  registerTerminalControls,
  subscribeTerminalOutput,
} from "./terminal-resources.js";
import React, { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { TerminalData, WorkspaceTerminal } from "../../shared/api.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { ContextMenu, type ContextMenuState } from "./context-menu.js";
import { terminalTheme } from "./terminal-theme.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const matchColors = {
  matchBackground: "#d2992266",
  activeMatchBackground: "#58a6ffaa",
  matchOverviewRuler: "#d29922",
  activeMatchColorOverviewRuler: "#58a6ff",
};

export const TerminalView = memo(function TerminalView({
  info,
  visible,
  takeFocus,
  onError,
}: {
  info: WorkspaceTerminal;
  visible: boolean;
  /** Only the focused pane's terminal grabs the keyboard when it appears. */
  takeFocus: boolean;
  onError(error: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const takeFocusRef = useRef(takeFocus);
  takeFocusRef.current = takeFocus;
  const observeResize = useRef<(active: boolean) => void>(() => {});
  const fit = useRef<() => void>(() => {});
  const renderer = useRef<(active: boolean) => void>(() => {});
  const terminal = useRef<Terminal | undefined>(undefined);
  const search = useRef<SearchAddon | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ContextMenuState>();
  const closeMenu = React.useCallback(() => setMenu(undefined), []);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = host.current!;
    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        '"SF Mono", "JetBrains Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      minimumContrastRatio: 3,
      scrollback: 5_000,
      screenReaderMode: visibleRef.current,
      // The unicode 11 addon (emoji and wide characters) uses xterm's proposed API.
      allowProposedApi: true,
    });
    const addon = new FitAddon();
    const finder = new SearchAddon();
    term.loadAddon(addon);
    term.loadAddon(finder);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.kairo.openExternal(uri).catch(() => {});
      }),
    );
    term.open(element);
    terminal.current = term;
    search.current = finder;
    // The GPU renderer is only kept for a terminal that is on screen; browsers cap WebGL contexts.
    let gpu: WebglAddon | undefined;
    renderer.current = (active) => {
      if (active && !gpu) {
        try {
          const next = new WebglAddon();
          next.onContextLoss(() => {
            next.dispose();
            if (gpu === next) gpu = undefined;
          });
          term.loadAddon(next);
          gpu = next;
        } catch {
          // Without WebGL xterm keeps its built-in renderer.
        }
      } else if (!active && gpu) {
        gpu.dispose();
        gpu = undefined;
      }
    };
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
    const openFind = () => {
      setFinding(true);
      window.setTimeout(() => findInput.current?.select(), 0);
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const modified = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modified && !event.shiftKey && key === "f") {
        openFind();
        return false;
      }
      if (modified && !event.shiftKey && key === "k") {
        term.clear();
        return false;
      }
      return !(
        modified &&
        (event.code === "Backquote" ||
          ["j", "p"].includes(key) ||
          (event.shiftKey && ["e", "d", "b", "n"].includes(key)))
      );
    });
    const stopControls = registerTerminalControls(info.id, {
      clear: () => term.clear(),
      focus: () => term.focus(),
      find: openFind,
    });
    fit.current = () => {
      if (visibleRef.current && element.clientWidth && element.clientHeight) addon.fit();
    };
    // Refit once a burst of size changes settles; every refit resizes the shell behind it, which
    // agents answer by redrawing the whole screen.
    let refit: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(refit);
      refit = window.setTimeout(() => fit.current(), 60);
    });
    observeResize.current = (active) => {
      observer.disconnect();
      if (active) observer.observe(element);
    };
    observeResize.current(visibleRef.current);
    if (visibleRef.current) renderer.current(true);
    const updateTheme = () => {
      term.options.theme = terminalTheme(element);
    };
    updateTheme();
    const stopTheme = observeTerminalTheme(updateTheme);
    return () => {
      disposed = true;
      unsubscribe();
      stopControls();
      window.clearTimeout(refit);
      observer.disconnect();
      stopTheme();
      input.dispose();
      resize.dispose();
      renderer.current(false);
      void window.kairo.detachTerminal(info.id).catch(() => {});
      terminal.current = undefined;
      search.current = undefined;
      term.dispose();
    };
  }, [info.id, onError]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = info.state !== "running";
  }, [info.state]);
  useEffect(() => {
    observeResize.current(visible);
    renderer.current(visible);
    if (terminal.current) terminal.current.options.screenReaderMode = visible;
    if (visible) {
      fit.current();
      if (
        takeFocusRef.current &&
        !(
          document.activeElement instanceof Element &&
          document.activeElement.closest('[role="tablist"]')
        )
      )
        terminal.current?.focus();
    }
  }, [visible]);

  const find = (backwards: boolean, text = query) => {
    if (!text) return search.current?.clearDecorations();
    const options = { decorations: matchColors };
    if (backwards) search.current?.findPrevious(text, options);
    else search.current?.findNext(text, options);
  };
  const closeFind = () => {
    setFinding(false);
    search.current?.clearDecorations();
    terminal.current?.focus();
  };
  const copy = () => {
    const selection = terminal.current?.getSelection();
    if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
  };
  const paste = () =>
    void navigator.clipboard
      .readText()
      .then((text) => terminal.current?.paste(text))
      .catch(() => {});

  return (
    <div
      className="terminal-view"
      role="tabpanel"
      id={`terminal-view-${info.id}`}
      aria-label={`${info.title} terminal`}
      hidden={!visible}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: host.current!,
          label: "Terminal actions",
          actions: [
            { label: "Copy", disabled: !terminal.current?.hasSelection(), run: copy },
            { label: "Paste", disabled: info.state !== "running", run: paste },
            { label: "Select all", run: () => terminal.current?.selectAll() },
            { label: "Find", run: () => terminal.current && setFinding(true) },
            { label: "Clear", run: () => terminal.current?.clear() },
          ],
        });
      }}
    >
      <div className="terminal-host" ref={host} />
      {finding && (
        <div className="terminal-find" role="search">
          <Input
            ref={findInput}
            autoFocus
            aria-label="Find in terminal"
            placeholder="Find"
            className="h-7 w-44 text-xs"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              find(false, event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") find(event.shiftKey);
              else if (event.key === "Escape") closeFind();
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Previous match"
            onClick={() => find(true)}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Next match"
            onClick={() => find(false)}
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close find"
            onClick={closeFind}
          >
            <X />
          </Button>
        </div>
      )}
      {menu && <ContextMenu key={`${menu.x}:${menu.y}`} menu={menu} close={closeMenu} />}
    </div>
  );
});
