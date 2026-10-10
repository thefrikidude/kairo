import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopBootstrap,
  TerminalSession,
  GitWorktree,
  ReviewScope,
  WorkspaceReview,
  WorkspaceSelection,
} from "../../shared/api.js";
import { retainBuffer, type EditorBuffer } from "./editor-buffer.js";
import { Icon, KairoLogo, ModalFrame } from "./chrome.js";
import { navigateTabs } from "./tab-navigation.js";
import { TerminalCatalog } from "./terminal-catalog.js";
const AgentTerminals = lazy(() => import("./agent-terminals.js"));
const FileBrowser = lazy(() => import("./file-browser.js"));
const ReviewPanel = lazy(() => import("./review-panel.js"));
const EMPTY_BUFFERS: Record<string, EditorBuffer> = {};
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const storedNumber = (key: string, fallback: number, min: number, max: number) => {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
};

export function DesktopApp(): React.JSX.Element {
  const [state, setState] = useState<DesktopBootstrap>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("kairo-theme") === "light" ? "light" : "dark",
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    storedNumber("kairo-sidebar-width", 224, 176, 420),
  );
  const [contextWidth, setContextWidth] = useState(() =>
    storedNumber("kairo-context-width", 420, 300, 800),
  );
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTab, setContextTab] = useState<"files" | "changes">("changes");
  const [shellId, setShellId] = useState<string>();
  const [creatingShell, setCreatingShell] = useState(false);
  const [settings, setSettings] = useState<"general" | "agents" | "archived" | "workspaces">();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("kairo-pinned-sessions") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [buffers, setBuffers] = useState<Record<string, Record<string, EditorBuffer>>>({});
  const [overview, setOverview] = useState<WorkspaceReview>();
  const [reviewError, setReviewError] = useState("");
  const [scope, setScope] = useState<ReviewScope>("task");
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<{ path: string; nonce: number }>();
  const [newOpen, setNewOpen] = useState(false);
  const [agentId, setAgentId] = useState(localStorage.getItem("kairo-last-agent") ?? "codex");
  const [agentQuery, setAgentQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<"folder" | "worktree" | "existing">("folder");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [trees, setTrees] = useState<GitWorktree[]>([]);
  const [existing, setExisting] = useState("");
  const [rename, setRename] = useState<{ id: string; title: string }>();
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
  }>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const current = state?.sessions.find((session) => session.id === state.activeSessionId);
  const selectedShell = state?.terminals.find((t) => t.id === shellId && !t.sessionId);
  const workspace = state?.workspaces.find(
    (item) =>
      item.id === (selectedShell?.workspaceId ?? current?.workspaceId ?? state.activeWorkspaceId),
  );
  const accessId = selectedShell ? workspace?.id : (current?.id ?? workspace?.id);
  const currentTerminal = current
    ? state?.terminals.find((terminal) => terminal.sessionId === current.id)
    : undefined;
  const activeTerminalId = selectedShell?.id ?? currentTerminal?.id;
  const projectTabs =
    state?.terminals.filter(
      (t) =>
        state.workspaces.find((w) => w.id === t.workspaceId)?.repositoryPath ===
        workspace?.repositoryPath,
    ) ?? [];
  useEffect(() => {
    setShellId(undefined);
  }, [state?.activeSessionId, state?.activeWorkspaceId]);
  const newShell = async () => {
    if (!workspace || creatingShell) return;
    setCreatingShell(true);
    setError("");
    try {
      const terminal = await window.kairo.createTerminal(workspace.id);
      setState((all) =>
        all
          ? { ...all, terminals: [...all.terminals.filter((t) => t.id !== terminal.id), terminal] }
          : all,
      );
      setShellId(terminal.id);
      setSettings(undefined);
    } catch (error) {
      setError(message(error));
    } finally {
      setCreatingShell(false);
    }
  };
  const dirty = Object.values(buffers).some((all) =>
    Object.values(all).some((buffer) => buffer.draft !== buffer.saved),
  );
  const apply = useCallback((value: DesktopBootstrap) => setState(value), []);
  const onError = useCallback((value: string) => setError(value), []);
  const groups = useMemo(() => {
    const map = new Map<string, TerminalSession[]>();
    for (const item of state?.workspaces ?? [])
      if (!item.removedAt) map.set(item.repositoryPath, []);
    for (const session of state?.sessions ?? []) {
      const owner = state?.workspaces.find((item) => item.id === session.workspaceId);
      if (!owner) continue;
      const items = map.get(owner.repositoryPath) ?? [];
      items.push(session);
      map.set(owner.repositoryPath, items);
    }
    return [...map].map(([path, sessions]) => ({ path, sessions }));
  }, [state?.workspaces, state?.sessions]);
  const action = useCallback(
    async (operation: () => Promise<DesktopBootstrap | undefined>) => {
      setPending(true);
      setError("");
      try {
        const value = await operation();
        if (value) apply(value);
      } catch (cause) {
        setError(message(cause));
        // Failed launches still retain the session and any newly created worktree.
        await window.kairo
          .bootstrap()
          .then(apply)
          .catch(() => {});
      } finally {
        setPending(false);
      }
    },
    [apply],
  );
  useEffect(() => {
    let disposed = false;
    const offState = window.kairo.onTerminalState((terminal) =>
      setState((all) =>
        all
          ? {
              ...all,
              terminals: all.terminals.some((item) => item.id === terminal.id)
                ? all.terminals.map((item) => (item.id === terminal.id ? terminal : item))
                : [...all.terminals, terminal],
            }
          : all,
      ),
    );
    const offClose = window.kairo.onTerminalClosed(({ id }) =>
      setState((all) =>
        all ? { ...all, terminals: all.terminals.filter((item) => item.id !== id) } : all,
      ),
    );
    const offError = window.kairo.onRuntimeError(({ error }) => setError(error));
    const offSessions = window.kairo.onSessionsChanged(() => {
      void window.kairo
        .bootstrap()
        .then((value) => {
          if (!disposed) apply(value);
        })
        .catch((cause) => setError(message(cause)));
    });
    void window.kairo
      .bootstrap()
      .then((value) => {
        if (!disposed) apply(value);
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      });
    return () => {
      disposed = true;
      offState();
      offClose();
      offError();
      offSessions();
    };
  }, [apply]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("kairo-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("kairo-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("kairo-context-width", String(contextWidth));
  }, [contextWidth]);
  useEffect(() => {
    localStorage.setItem("kairo-pinned-sessions", JSON.stringify(pinned));
  }, [pinned]);
  useEffect(() => {
    window.kairo.setUnsavedChanges(dirty);
  }, [dirty]);
  const refreshAgents = useCallback(async () => {
    setDetecting(true);
    try {
      const agents = await window.kairo.refreshAgents();
      setState((all) => (all ? { ...all, agents } : all));
      setAgentId((id) =>
        agents.some((agent) => agent.id === id && agent.installed)
          ? id
          : (agents.find((agent) => agent.installed)?.id ?? id),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setDetecting(false);
    }
  }, []);
  const beginSession = useCallback(
    (path?: string) => {
      const selected = stateRef.current?.workspaces.find(
        (item) => item.id === stateRef.current?.activeWorkspaceId,
      );
      setProject(path ?? selected?.repositoryPath ?? "");
      setBranch(`kairo/task-${Date.now().toString(36)}`);
      setBase("HEAD");
      setAgentQuery("");
      setMode(selected && selected.kind !== "folder" ? "worktree" : "folder");
      setExisting(selected?.directory ?? "");
      setError("");
      setNewOpen(true);
      void refreshAgents();
    },
    [refreshAgents],
  );
  useEffect(() => {
    if (!newOpen || !project) {
      setTrees([]);
      return;
    }
    let disposed = false;
    void window.kairo
      .listWorktrees(project)
      .then((items) => {
        if (disposed) return;
        setTrees(items);
        if (items.length) setMode("worktree");
        setExisting((value) =>
          items.some((item) => item.directory === value) ? value : (items[0]?.directory ?? ""),
        );
      })
      .catch(() => {
        if (!disposed) {
          setTrees([]);
          setMode("folder");
        }
      });
    return () => {
      disposed = true;
    };
  }, [newOpen, project]);
  useEffect(() => {
    if (!contextOpen || !accessId || workspace?.removedAt || settings) return;
    let disposed = false,
      fetching = false;
    setOverview(undefined);
    setReviewError("");
    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const value = await window.kairo.review(accessId, scope);
        if (!disposed) {
          setOverview(value);
          setReviewError("");
          setRevision((value) => value + 1);
        }
      } catch (cause) {
        if (!disposed) setReviewError(message(cause));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [accessId, contextOpen, scope, workspace?.removedAt, settings]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if ((event.metaKey || event.ctrlKey) && event.code === "Backquote") {
        event.preventDefault();
        void newShell();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        ["e", "d", "b", "n"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        const key = event.key.toLowerCase();
        if (key === "b") setSidebarOpen((value) => !value);
        else if (key === "n") beginSession();
        else {
          setContextTab(key === "e" ? "files" : "changes");
          setContextOpen(true);
        }
      } else if (
        event.key === "Escape" &&
        !(event.target instanceof Element && event.target.closest(".terminal-view"))
      ) {
        if (settings) setSettings(undefined);
        else if (contextOpen) setContextOpen(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [beginSession, settings, contextOpen, workspace?.id, creatingShell]);
  const create = async () => {
    const selection: WorkspaceSelection =
      mode === "worktree"
        ? { kind: mode, branch, baseRef: base }
        : mode === "existing"
          ? { kind: mode, directory: existing }
          : { kind: "folder" };
    setPending(true);
    setError("");
    try {
      apply(await window.kairo.newSession(agentId, project, selection));
      localStorage.setItem("kairo-last-agent", agentId);
      setNewOpen(false);
    } catch (cause) {
      setError(message(cause));
      await window.kairo
        .bootstrap()
        .then(apply)
        .catch(() => {});
    } finally {
      setPending(false);
    }
  };
  const resizeHandle = (kind: "sidebar" | "context") => {
    const value = kind === "sidebar" ? sidebarWidth : contextWidth;
    const update = (value: number) =>
      kind === "sidebar"
        ? setSidebarWidth(Math.max(176, Math.min(420, value)))
        : setContextWidth(Math.max(300, Math.min(800, value)));
    return (
      <div
        className={`${kind === "sidebar" ? "sidebar-resize-handle" : "context-resize-handle"}`}
        role="separator"
        tabIndex={0}
        aria-label={`Resize ${kind === "sidebar" ? "sidebar" : "workspace panel"}`}
        aria-orientation="vertical"
        aria-valuemin={kind === "sidebar" ? 176 : 300}
        aria-valuemax={kind === "sidebar" ? 420 : 800}
        aria-valuenow={value}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            update(value + (event.key === "ArrowRight" ? 16 : -16) * (kind === "sidebar" ? 1 : -1));
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const node = event.currentTarget,
            start = event.clientX;
          node.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) =>
            update(value + (next.clientX - start) * (kind === "sidebar" ? 1 : -1));
          const end = () => {
            node.removeEventListener("pointermove", move);
            node.removeEventListener("pointerup", end);
            node.removeEventListener("pointercancel", end);
          };
          node.addEventListener("pointermove", move);
          node.addEventListener("pointerup", end);
          node.addEventListener("pointercancel", end);
        }}
      />
    );
  };
  const agentPicker = (
    <>
      <div className="agent-picker-heading">
        <input
          aria-label="Search agents"
          placeholder="Search agents…"
          value={agentQuery}
          onChange={(event) => setAgentQuery(event.target.value)}
        />
        <button disabled={detecting} onClick={() => void refreshAgents()}>
          {detecting ? "Detecting…" : "Refresh agents"}
        </button>
      </div>
      <div className="agent-picker-list" role="listbox" aria-label="CLI agents">
        {(state?.agents ?? [])
          .filter((agent) =>
            `${agent.name} ${agent.id} ${agent.commands.join(" ")}`
              .toLowerCase()
              .includes(agentQuery.toLowerCase()),
          )
          .sort((a, b) => Number(b.installed) - Number(a.installed))
          .map((agent) => (
            <div
              className={`agent-picker-row ${agentId === agent.id ? "selected" : ""}`}
              key={agent.id}
            >
              <button
                role="option"
                aria-selected={agentId === agent.id}
                onClick={() => setAgentId(agent.id)}
              >
                <strong>{agent.name}</strong>
                <small>
                  {agent.installed ? "Installed" : "Not installed"} · {agent.commands[0]}
                </small>
              </button>
              {!agent.installed && (
                <button
                  aria-label={`Install ${agent.name}`}
                  onClick={() =>
                    void window.kairo
                      .openAgentHomepage(agent.id)
                      .catch((cause) => setError(message(cause)))
                  }
                >
                  Install guide ↗
                </button>
              )}
            </div>
          ))}
      </div>
      {state?.agents.find((agent) => agent.id === agentId)?.unavailableReason && (
        <p className="empty-small">
          {state.agents.find((agent) => agent.id === agentId)!.unavailableReason}
        </p>
      )}
    </>
  );
  return (
    <div
      className={`app-shell ${!settings ? "tools-visible" : ""} ${contextOpen && !settings && accessId && workspace ? "review-open" : ""} ${sidebarOpen ? "" : "sidebar-closed"}`}
      data-theme={theme}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--context-width": `${contextWidth}px`,
        } as React.CSSProperties
      }
    >
      <aside className="sidebar" aria-label="Agent sessions" hidden={!sidebarOpen}>
        <div className="brand">
          <KairoLogo className="brand-mark" />
          <span>Kairo</span>
        </div>
        <button className="new-chat" onClick={() => beginSession()}>
          <Icon name="plus" /> New agent session
        </button>
        <button
          className="open-project-button"
          disabled={pending}
          onClick={() => void action(() => window.kairo.openWorkspace())}
        >
          <Icon name="folder" /> Open project
        </button>
        <div className="section-label sidebar-section-title">Projects</div>
        <div className="project-session-list">
          {groups.map((group) => (
            <section className="project-session-group" key={group.path}>
              <div className="project-heading-row">
                <button
                  className="project-heading"
                  title={group.path}
                  aria-expanded={!collapsed[group.path]}
                  onClick={() =>
                    setCollapsed((all) => ({ ...all, [group.path]: !all[group.path] }))
                  }
                >
                  <Icon name="chevron" />
                  <Icon name="folder" />
                  <span>{name(group.path)}</span>
                </button>
                <button
                  className="project-menu-button"
                  aria-label={`New session in ${name(group.path)}`}
                  onClick={() => beginSession(group.path)}
                >
                  +
                </button>
              </div>
              <div hidden={collapsed[group.path]}>
                {[...group.sessions]
                  .sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)))
                  .map((session) => {
                    const owner = state?.workspaces.find((item) => item.id === session.workspaceId);
                    const terminal = state?.terminals.find((item) => item.sessionId === session.id);
                    return (
                      <div
                        key={session.id}
                        data-session-id={session.id}
                        className={`session-row ${current?.id === session.id ? "selected" : ""}`}
                      >
                        <button
                          className="session"
                          aria-current={current?.id === session.id ? "page" : undefined}
                          disabled={pending}
                          onClick={() => {
                            setSettings(undefined);
                            setShellId(undefined);
                            void action(() => window.kairo.openSession(session.id));
                          }}
                        >
                          <span
                            className={`session-status status-${terminal?.state === "running" ? "complete" : terminal?.state === "exited" && terminal.exitCode ? "error" : "idle"}`}
                            title={
                              terminal?.state === "running" ? "Terminal open" : "Terminal stopped"
                            }
                          />
                          <span className="session-labels">
                            <span className="session-title">{session.title}</span>
                            <small className="session-workspace-label">
                              {owner?.branch ??
                                state?.agents.find((agent) => agent.id === session.agentId)?.name}
                            </small>
                          </span>
                        </button>
                        <div className="session-row-actions">
                          <button
                            className="session-action-button"
                            aria-label={`Rename ${session.title}`}
                            onClick={() => setRename({ id: session.id, title: session.title })}
                          >
                            ✎
                          </button>
                          <button
                            className={`session-action-button ${pinned.includes(session.id) ? "pinned" : ""}`}
                            aria-label="Pin session"
                            aria-pressed={pinned.includes(session.id)}
                            onClick={() =>
                              setPinned((all) =>
                                all.includes(session.id)
                                  ? all.filter((id) => id !== session.id)
                                  : [...all, session.id],
                              )
                            }
                          >
                            <Icon name="pin" />
                          </button>
                          <button
                            className="session-action-button"
                            aria-label={`Archive ${session.title}`}
                            disabled={!!terminal || pending}
                            title={
                              terminal ? "Stop the terminal before archiving" : "Archive session"
                            }
                            onClick={() =>
                              void action(() => window.kairo.archiveSession(session.id))
                            }
                          >
                            <Icon name="archive" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                {!group.sessions.length && (
                  <button
                    className="empty-session-list"
                    onClick={() => {
                      const owner = state?.workspaces.find(
                        (item) => !item.removedAt && item.repositoryPath === group.path,
                      );
                      if (owner) void action(() => window.kairo.selectWorkspace(owner.id));
                    }}
                  >
                    Select project
                  </button>
                )}
              </div>
            </section>
          ))}
          {!groups.length && <p className="empty-session-list">Open a project to get started</p>}
        </div>
        <button className="settings-link" onClick={() => setSettings("general")}>
          <Icon name="settings" /> Settings
        </button>
      </aside>
      {sidebarOpen && resizeHandle("sidebar")}
      <main className="conversation">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <Icon name="sidebar" />
          </button>
          {settings ? (
            <>
              <strong>Settings</strong>
              <button onClick={() => setSettings(undefined)}>Back to workspace</button>
            </>
          ) : (
            <>
              <div
                className="terminal-tabs"
                role="tablist"
                aria-label="Terminal tabs"
                onKeyDown={navigateTabs}
              >
                {projectTabs.map((terminal) => (
                  <button
                    key={terminal.id}
                    role="tab"
                    aria-selected={terminal.id === activeTerminalId}
                    tabIndex={terminal.id === activeTerminalId ? 0 : -1}
                    aria-controls={`terminal-view-${terminal.id}`}
                    title={terminal.directory}
                    onClick={() => {
                      if (terminal.sessionId) {
                        setShellId(undefined);
                        void action(() => window.kairo.openSession(terminal.sessionId!));
                      } else setShellId(terminal.id);
                    }}
                  >
                    {terminal.sessionId
                      ? (state?.sessions.find((s) => s.id === terminal.sessionId)?.title ??
                        terminal.title)
                      : `Terminal ${projectTabs.filter((t) => !t.sessionId).findIndex((t) => t.id === terminal.id) + 1}`}
                  </button>
                ))}
              </div>
              <div className="terminal-tab-actions">
                <button
                  aria-label="New terminal tab"
                  disabled={!workspace || !!workspace.removedAt || creatingShell}
                  onClick={() => void newShell()}
                >
                  + Terminal
                </button>
                <button
                  aria-label="New agent tab"
                  disabled={pending}
                  onClick={() => beginSession()}
                >
                  + Agent
                </button>
              </div>
            </>
          )}
        </header>
        {error && (
          <div className="desktop-error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        <section className="settings-content terminal-settings" hidden={!settings}>
          <div className="settings-tabs">
            {(["general", "agents", "archived", "workspaces"] as const).map((tab) => (
              <button
                key={tab}
                aria-pressed={settings === tab}
                onClick={() => {
                  setSettings(tab);
                  if (tab === "agents") void refreshAgents();
                }}
              >
                {tab === "archived" ? "Archived sessions" : tab[0].toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          {settings === "general" && (
            <>
              <h2>General</h2>
              <p>
                Agent conversations run inside the selected CLI. Models, authentication and
                approvals are managed by that agent.
              </p>
              <label className="settings-field">
                Appearance
                <select
                  aria-label="Theme"
                  value={theme}
                  onChange={(event) => setTheme(event.target.value as "light" | "dark")}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <p>
                Cmd/Ctrl+Shift+N: new session · Cmd/Ctrl+Shift+E: files · Cmd/Ctrl+Shift+D: review ·
                Cmd/Ctrl+`: new terminal tab
              </p>
            </>
          )}
          {settings === "agents" && (
            <>
              <h2>Installed agents</h2>
              <p>
                Install an agent on your system, then refresh. Kairo launches its interactive CLI.
              </p>
              {agentPicker}
            </>
          )}
          {settings === "archived" && (
            <>
              <h2>Archived sessions</h2>
              {state?.archivedSessions.map((session) => (
                <article className="workspace-catalog-row" key={session.id}>
                  <div>
                    <strong>{session.title}</strong>
                    <code>
                      {state.workspaces.find((item) => item.id === session.workspaceId)?.directory}
                    </code>
                  </div>
                  <button
                    disabled={
                      pending ||
                      !!state.workspaces.find((item) => item.id === session.workspaceId)?.removedAt
                    }
                    onClick={() => void action(() => window.kairo.restoreSession(session.id))}
                  >
                    Restore
                  </button>
                  <button
                    className="danger-outline-button"
                    onClick={() =>
                      setConfirm({
                        title: "Delete session?",
                        description: `Delete “${session.title}” from Kairo. Its workspace and the agent’s own history are kept.`,
                        action: () => window.kairo.deleteSession(session.id).then(apply),
                      })
                    }
                  >
                    Delete
                  </button>
                </article>
              ))}
              {!state?.archivedSessions.length && (
                <p className="empty-small">No archived sessions</p>
              )}
            </>
          )}
          {settings === "workspaces" && (
            <>
              <h2>Workspaces</h2>
              {state?.workspaces
                .filter((item) => !item.removedAt)
                .map((item) => (
                  <article className="workspace-catalog-row" key={item.id}>
                    <div>
                      <strong>{item.branch ?? name(item.directory)}</strong>
                      <small>{item.kind}</small>
                      <code>{item.directory}</code>
                    </div>
                    <button
                      disabled={pending}
                      onClick={() => {
                        setSettings(undefined);
                        void action(() => window.kairo.selectWorkspace(item.id));
                      }}
                    >
                      Open
                    </button>
                    {item.managed && (
                      <button
                        className="danger-outline-button"
                        disabled={
                          pending ||
                          state.sessions.some((session) => session.workspaceId === item.id) ||
                          Object.values(buffers[item.id] ?? {}).some(
                            (buffer) => buffer.draft !== buffer.saved,
                          )
                        }
                        title="Archive sessions and close terminals before removing a worktree"
                        onClick={() =>
                          setConfirm({
                            title: "Remove worktree?",
                            description:
                              "Remove this clean worktree folder. Git preserves its branch and refuses removal while uncommitted files or unmerged commits remain.",
                            action: () => window.kairo.removeWorktree(item.id).then(apply),
                          })
                        }
                      >
                        Remove worktree
                      </button>
                    )}
                  </article>
                ))}
              <TerminalCatalog />
            </>
          )}
        </section>
        <div className="agent-workspace" hidden={!!settings}>
          <Suspense fallback={<p className="empty-small">Loading terminal…</p>}>
            <AgentTerminals
              terminals={state?.terminals ?? []}
              activeTerminalId={settings ? undefined : activeTerminalId}
              onError={onError}
            />
          </Suspense>
          {!activeTerminalId && (
            <div className="welcome">
              <KairoLogo className="welcome-logo" />
              <h1>
                {current
                  ? "Agent terminal stopped"
                  : workspace
                    ? "Start an agent session"
                    : "Open your project"}
              </h1>
              <p>
                {current
                  ? "Your workspace and session association are saved."
                  : "Choose an installed agent and work in its terminal inside Kairo."}
              </p>
              <button
                className="primary"
                disabled={pending}
                onClick={() =>
                  current
                    ? void action(() => window.kairo.startSession(current.id))
                    : workspace
                      ? beginSession()
                      : void action(() => window.kairo.openWorkspace())
                }
              >
                {current
                  ? "Open agent terminal"
                  : workspace
                    ? "New agent session"
                    : "Open project folder"}
              </button>
            </div>
          )}
        </div>
      </main>
      {!settings && (
        <aside className="workspace-tools" aria-label="Workspace tools">
          <button
            className="review-toggle"
            disabled={!accessId || !!workspace?.removedAt}
            aria-label="Browse files"
            title="Files"
            aria-expanded={contextOpen && contextTab === "files"}
            onClick={() => {
              setContextTab("files");
              setContextOpen(!(contextOpen && contextTab === "files"));
            }}
          >
            <Icon name="folder" /> <span>Files</span>
          </button>
          <button
            className="review-toggle"
            disabled={!accessId || !!workspace?.removedAt}
            aria-label="Review changes"
            title="Review"
            aria-expanded={contextOpen && contextTab === "changes"}
            onClick={() => {
              setContextTab("changes");
              setContextOpen(!(contextOpen && contextTab === "changes"));
            }}
          >
            <Icon name="panel" /> <span>Review</span>{" "}
            {overview?.changes.length ? (
              <span className="count">{overview.changes.length}</span>
            ) : null}
          </button>
        </aside>
      )}

      {contextOpen && !settings && accessId && workspace && (
        <aside className="workbench" id="workspace-panel" aria-label="Workspace files and review">
          {resizeHandle("context")}
          <header className="workbench-header">
            <div
              className="context-tab-list"
              role="tablist"
              aria-label="Workspace tabs"
              onKeyDown={navigateTabs}
            >
              {(["files", "changes"] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  tabIndex={contextTab === tab ? 0 : -1}
                  aria-selected={contextTab === tab}
                  onClick={() => setContextTab(tab)}
                >
                  {tab === "files" ? "Files" : "Review"}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={() => {
                void window.kairo
                  .review(accessId, scope)
                  .then((value) => {
                    setOverview(value);
                    setRevision((value) => value + 1);
                  })
                  .catch((cause) => setReviewError(message(cause)));
              }}
            >
              <Icon name="refresh" />
            </button>
            <button
              className="icon-button"
              aria-label="Close workspace panel"
              onClick={() => setContextOpen(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          <Suspense fallback={<p className="empty-small">Loading workspace…</p>}>
            {contextTab === "files" ? (
              <FileBrowser
                key={workspace.id}
                sessionId={accessId}
                busy={false}
                buffers={buffers[workspace.id] ?? EMPTY_BUFFERS}
                changes={overview?.changes ?? []}
                revision={revision}
                target={target}
                onBuffer={(path, buffer) =>
                  setBuffers((all) => retainBuffer(all, workspace.id, path, buffer))
                }
                onSaved={() => setRevision((value) => value + 1)}
              />
            ) : (
              <ReviewPanel
                key={workspace.id}
                sessionId={accessId}
                overview={overview}
                error={reviewError}
                scope={scope}
                canReviewTask={!!workspace.baseCommit}
                revision={revision}
                onScope={setScope}
                onOpenFile={(path) => {
                  setTarget({ path, nonce: Date.now() });
                  setContextTab("files");
                }}
              />
            )}
          </Suspense>
        </aside>
      )}
      <footer className="statusbar">
        <span>
          {workspace
            ? `${workspace.kind === "worktree" ? "Isolated worktree" : "Local workspace"} · ${state?.terminals.filter((terminal) => terminal.state === "running").length ?? 0} open terminals`
            : "Local agent desktop"}
        </span>
        <span>{dirty ? "Unsaved file edits" : ""}</span>
      </footer>
      {newOpen && (
        <ModalFrame
          labelledBy="new-session-title"
          blocked={pending}
          onDismiss={() => setNewOpen(false)}
        >
          <div className="new-session-dialog">
            <h2 id="new-session-title">New agent session</h2>
            <label className="settings-field">
              Project folder
              <div className="folder-picker">
                <input
                  aria-label="Project folder"
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                />
                <button
                  disabled={pending}
                  onClick={() =>
                    void window.kairo.pickWorkspace().then((value) => {
                      if (value) setProject(value);
                    })
                  }
                >
                  Browse…
                </button>
              </div>
            </label>
            {agentPicker}
            <label className="settings-field">
              Workspace
              <select
                aria-label="Workspace mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="folder">Project folder</option>
                {trees.length > 0 && (
                  <>
                    <option value="worktree">New isolated worktree</option>
                    <option value="existing">Existing worktree</option>
                  </>
                )}
              </select>
            </label>
            {mode === "worktree" && (
              <>
                <label className="settings-field">
                  Branch
                  <input
                    aria-label="Branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>
                <label className="settings-field">
                  Starting branch or commit
                  <input
                    aria-label="Base reference"
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                  />
                </label>
                <p className="empty-small">
                  Starts from committed code. Uncommitted edits and dependencies are not copied.
                </p>
              </>
            )}
            {mode === "existing" && (
              <label className="settings-field">
                Existing worktree
                <select
                  aria-label="Existing worktree"
                  value={existing}
                  onChange={(event) => setExisting(event.target.value)}
                >
                  {trees.map((tree) => (
                    <option value={tree.directory} key={tree.directory}>
                      {tree.branch ?? "Detached"} · {tree.directory}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <p className="file-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={pending} onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  pending ||
                  detecting ||
                  !project ||
                  !state?.agents.find((agent) => agent.id === agentId)?.installed
                }
                onClick={() => void create()}
              >
                {pending ? "Opening…" : "Open agent terminal"}
              </button>
            </div>
          </div>
        </ModalFrame>
      )}
      {rename && (
        <ModalFrame
          labelledBy="rename-title"
          blocked={pending}
          onDismiss={() => setRename(undefined)}
        >
          <form
            className="new-session-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void action(() => window.kairo.renameSession(rename.id, rename.title)).then(() =>
                setRename(undefined),
              );
            }}
          >
            <h2 id="rename-title">Rename session</h2>
            <input
              autoFocus
              aria-label="Session name"
              maxLength={200}
              value={rename.title}
              onChange={(event) => setRename({ ...rename, title: event.target.value })}
            />
            <div className="modal-actions">
              <button type="button" disabled={pending} onClick={() => setRename(undefined)}>
                Cancel
              </button>
              <button className="primary" disabled={pending || !rename.title.trim()}>
                Save name
              </button>
            </div>
          </form>
        </ModalFrame>
      )}
      {confirm && (
        <ModalFrame
          labelledBy="confirm-title"
          blocked={pending}
          onDismiss={() => setConfirm(undefined)}
        >
          <div className="new-session-dialog">
            <h2 id="confirm-title">{confirm.title}</h2>
            <p>{confirm.description}</p>
            {error && (
              <p className="file-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={pending} onClick={() => setConfirm(undefined)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError("");
                  void confirm
                    .action()
                    .then(() => setConfirm(undefined))
                    .catch((cause) => setError(message(cause)))
                    .finally(() => setPending(false));
                }}
              >
                {pending ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </ModalFrame>
      )}
    </div>
  );
}
