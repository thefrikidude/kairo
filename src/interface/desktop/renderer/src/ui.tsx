import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopBootstrap,
  TaskWorkspace,
  ReviewScope,
  WorkspaceReview,
} from "../../shared/api.js";
import { retainBuffer, type EditorBuffer } from "./editor-buffer.js";
import { Icon, KairoLogo, ModalFrame } from "./chrome.js";
import { navigateTabs } from "./tab-navigation.js";
import { rememberedShell, openWorkspaceShell } from "./workspace-selection.js";
import { WorkspaceDialog, ProjectSettings } from "./workspace-dialog.js";
import { WorkspacePalette } from "./workspace-palette.js";
import { ContextMenu, type ContextAction, type ContextMenuState } from "./context-menu.js";
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
  const [archived, setArchived] = useState<DesktopBootstrap["archivedSessions"]>([]);
  const [preparationOutput, setPreparationOutput] = useState("");
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
  const [workspaceDialog, setWorkspaceDialog] = useState<string>();
  const [projectSettings, setProjectSettings] = useState<string>();
  const [palette, setPalette] = useState<"jump" | "file">();
  const [operationId, setOperationId] = useState<string>();
  const [buffers, setBuffers] = useState<Record<string, Record<string, EditorBuffer>>>({});
  const [overview, setOverview] = useState<WorkspaceReview>();
  const [reviewError, setReviewError] = useState("");
  const [scope, setScope] = useState<ReviewScope>("task");
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<{ path: string; nonce: number; workspaceId: string }>();
  const [newOpen, setNewOpen] = useState(false);
  const [agentId, setAgentId] = useState(localStorage.getItem("kairo-last-agent") ?? "codex");
  const [agentQuery, setAgentQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [rename, setRename] = useState<{ id: string; title: string; workspace?: boolean }>();
  const [rowMenu, setRowMenu] = useState<ContextMenuState>();
  const closeRowMenu = useCallback(() => setRowMenu(undefined), []);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
  }>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectionVersion = useRef(0);
  const current = state?.sessions.find((session) => session.id === state.activeSessionId);
  const selectedShell = state?.terminals.find(
    (t) => t.id === shellId && !t.sessionId && t.workspaceId === state.activeWorkspaceId,
  );
  const workspace = state?.workspaces.find(
    (item) =>
      item.id === (selectedShell?.workspaceId ?? current?.workspaceId ?? state.activeWorkspaceId),
  );
  const accessId = selectedShell ? workspace?.id : (current?.id ?? workspace?.id);
  const currentTerminal = current
    ? state?.terminals.find((terminal) => terminal.sessionId === current.id)
    : undefined;
  const activeTerminalId = selectedShell?.id ?? currentTerminal?.id;
  const projectTabs = state?.terminals.filter((t) => t.workspaceId === workspace?.id) ?? [];
  const stoppedSessions =
    state?.sessions.filter(
      (s) => s.workspaceId === workspace?.id && !projectTabs.some((t) => t.sessionId === s.id),
    ) ?? [];
  const operation =
    state?.operations.find((op) => op.id === operationId) ??
    state?.operations.find(
      (op) =>
        !!op.workspaceId && op.workspaceId === workspace?.id && (op.phase !== "ready" || op.error),
    );
  useEffect(() => {
    if (settings !== "archived") return;
    let disposed = false;
    void window.kairo
      .archivedSessions()
      .then((value) => {
        if (!disposed) setArchived(value);
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      });
    return () => {
      disposed = true;
    };
  }, [settings, state]);
  const previousPreparationId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousPreparationId.current !== operation?.id) setPreparationOutput("");
    previousPreparationId.current = operation?.id;
    if (!operation) return;
    let disposed = false;
    void window.kairo
      .preparation(operation.id)
      .then((value) => {
        if (!disposed) setPreparationOutput(value.output);
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      });
    return () => {
      disposed = true;
    };
  }, [operation]);
  const savedShellId = rememberedShell(
    state?.activeWorkspaceId,
    state?.workspaces.find((w) => w.id === state.activeWorkspaceId)?.lastTab,
    state?.terminals,
  );
  useEffect(() => {
    setShellId(savedShellId);
  }, [state?.activeSessionId, state?.activeWorkspaceId, savedShellId]);
  useEffect(() => {
    if (!workspace?.id) return;
    const refresh = () =>
      void window.kairo
        .refreshWorkspace(workspace.id)
        .then(apply)
        .catch((cause) => setError(message(cause)));
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [workspace?.id]);
  const newShell = async () => {
    if (!workspace || creatingShell) return;
    setCreatingShell(true);
    setError("");
    const version = selectionVersion.current;
    try {
      await openWorkspaceShell(
        window.kairo,
        workspace.id,
        (terminal) =>
          setState((all) =>
            all
              ? {
                  ...all,
                  terminals: [...all.terminals.filter((t) => t.id !== terminal.id), terminal],
                }
              : all,
          ),
        () =>
          selectionVersion.current === version &&
          stateRef.current?.activeWorkspaceId === workspace.id,
        (terminal) => {
          setShellId(terminal.id);
          setSettings(undefined);
        },
      );
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
    const map = new Map<string, TaskWorkspace[]>();
    for (const item of state?.workspaces ?? []) {
      if (item.removedAt || item.archivedAt) continue;
      map.set(item.repositoryPath, [...(map.get(item.repositoryPath) ?? []), item]);
    }
    for (const op of state?.operations ?? [])
      if (!op.workspaceId && op.phase !== "ready") {
        if (!map.has(op.repositoryPath)) map.set(op.repositoryPath, []);
      }
    return [...map].map(([path, workspaces]) => ({ path, workspaces }));
  }, [state?.workspaces, state?.operations]);
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
          .bootstrap(true)
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
    let refreshing = false;
    let refreshAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      timer = undefined;
      if (disposed) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        const value = await window.kairo.bootstrap(true);
        if (!disposed) apply(value);
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        refreshing = false;
        if (refreshAgain && !disposed) {
          refreshAgain = false;
          timer = setTimeout(refresh, 30);
        }
      }
    };
    const offSessions = window.kairo.onSessionsChanged(() => {
      if (!timer) timer = setTimeout(refresh, 30);
    });
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
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
  const migratedPins = useRef(false);
  useEffect(() => {
    if (!state || migratedPins.current) return;
    migratedPins.current = true;
    void (async () => {
      let ids: string[] = [];
      try {
        ids = JSON.parse(localStorage.getItem("kairo-pinned-sessions") ?? "[]");
      } catch {}
      if (!Array.isArray(ids)) return;
      for (const workspaceId of new Set(
        state.sessions
          .filter((session) => ids.includes(session.id))
          .map((session) => session.workspaceId),
      ))
        await window.kairo.pinWorkspace(workspaceId, true);
      localStorage.removeItem("kairo-pinned-sessions");
      if (ids.length) apply(await window.kairo.bootstrap(true));
    })().catch((cause) => setError(message(cause)));
  }, [state, apply]);
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
  const beginSession = useCallback(() => {
    setAgentQuery("");
    setError("");
    setNewOpen(true);
    void refreshAgents();
  }, [refreshAgents]);
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
      const modifier = navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (modifier && ["j", "p"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        setPalette(event.key.toLowerCase() === "j" ? "jump" : "file");
      } else if (modifier && event.code === "Backquote") {
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
        else if (key === "n") setWorkspaceDialog(workspace?.repositoryPath ?? "");
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
    setPending(true);
    setError("");
    try {
      if (!workspace) throw new Error("Select a workspace first.");
      apply(await window.kairo.newSession(agentId, workspace.directory));
      localStorage.setItem("kairo-last-agent", agentId);
      setNewOpen(false);
    } catch (cause) {
      setError(message(cause));
      await window.kairo
        .bootstrap(true)
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
  const chooseWorkspace = async (id: string, tab?: string) => {
    selectionVersion.current++;
    setOperationId(undefined);
    setSettings(undefined);
    await action(async () => {
      const value = await window.kairo.selectWorkspace(id);
      if (tab?.startsWith("session:")) return window.kairo.openSession(tab.slice(8));
      if (tab?.startsWith("terminal:")) await window.kairo.rememberWorkspaceTab(id, tab);
      return tab ? window.kairo.bootstrap(true) : value;
    });
  };
  const menuHandlers = (label: string, actions: ContextAction[]) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const trigger = event.currentTarget.matches("button")
        ? event.currentTarget
        : (event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget);
      setRowMenu({ x: event.clientX, y: event.clientY, trigger, label, actions });
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const trigger = event.target as HTMLElement;
      const bounds = trigger.getBoundingClientRect();
      setRowMenu({ x: bounds.left, y: bounds.bottom, trigger, label, actions });
    },
  });
  const projectActions = (path: string): ContextAction[] => [
    { label: "New workspace", disabled: pending, run: () => setWorkspaceDialog(path) },
    { label: "Project setup", run: () => setProjectSettings(path) },
  ];
  const agentActions = (id: string): ContextAction[] => {
    const session = state?.sessions.find((session) => session.id === id);
    return session
      ? [
          {
            label: "Rename agent tab",
            disabled: pending,
            run: () => setRename({ id, title: session.title }),
          },
          {
            label: "Archive agent tab",
            disabled: pending,
            run: () => void action(() => window.kairo.archiveSession(id)),
          },
        ]
      : [];
  };
  const renderWorkspace = (item: TaskWorkspace) => {
    const op = state?.operations.find((op) => op.workspaceId === item.id);
    const label = item.name ?? item.branch ?? name(item.directory);
    return (
      <div
        key={item.id}
        data-workspace-id={item.id}
        className={`session-row workspace-row ${workspace?.id === item.id ? "selected" : ""}`}
        {...menuHandlers(`${label} actions`, [
          {
            label: "Rename",
            disabled: pending,
            run: () => setRename({ id: item.id, title: label, workspace: true }),
          },
          {
            label: item.pinned ? "Unpin" : "Pin",
            disabled: pending,
            run: () => void action(() => window.kairo.pinWorkspace(item.id, !item.pinned)),
          },
          {
            label: "Archive",
            disabled: pending,
            run: () => {
              if (Object.values(buffers[item.id] ?? {}).some((b) => b.draft !== b.saved)) {
                setError("Save or discard this workspace’s unsaved file edits before archiving.");
                return;
              }
              setConfirm({
                title: "Archive workspace?",
                description:
                  "Close this workspace’s terminals and hide it. Files, branches, and agent session identities are kept.",
                action: () => window.kairo.archiveWorkspace(item.id).then(apply),
              });
            },
          },
          ...projectActions(item.repositoryPath),
        ])}
      >
        <button
          className="session"
          aria-current={workspace?.id === item.id ? "page" : undefined}
          disabled={pending}
          onClick={() => void chooseWorkspace(item.id)}
        >
          <span
            className={`session-status status-${item.unavailable ? "error" : state?.terminals.some((t) => t.workspaceId === item.id && t.state === "running") ? "complete" : "idle"}`}
          />
          <span className="session-labels">
            <span className="session-title">{label}</span>
            <small className="session-workspace-label">
              {item.unavailable
                ? "Unavailable"
                : op && op.phase !== "ready"
                  ? op.phase
                  : (item.branch ?? item.kind)}
            </small>
          </span>
        </button>
      </div>
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
      <aside className="sidebar" aria-label="Workspaces" hidden={!sidebarOpen}>
        <div className="brand">
          <KairoLogo className="brand-mark" />
          <span>Kairo</span>
        </div>
        <button
          className="new-chat"
          onClick={() => setWorkspaceDialog(workspace?.repositoryPath ?? "")}
        >
          <Icon name="plus" /> New workspace
        </button>
        <button
          className="open-project-button"
          disabled={pending}
          onClick={() => void action(() => window.kairo.openWorkspace())}
        >
          <Icon name="folder" /> Open project
        </button>
        {state?.workspaces.some((w) => w.pinned && !w.archivedAt && !w.removedAt) && (
          <section className="pinned-sessions" aria-label="Pinned workspaces">
            <div className="section-label sidebar-section-title">Pinned</div>
            {state.workspaces
              .filter((w) => w.pinned && !w.archivedAt && !w.removedAt)
              .map(renderWorkspace)}
          </section>
        )}
        <button className="open-project-button" onClick={() => setPalette("jump")}>
          Jump to workspace
        </button>
        <div className="section-label sidebar-section-title">Projects</div>
        <div className="project-session-list">
          {groups.map((group) => (
            <section className="project-session-group" key={group.path}>
              <div
                className="project-heading-row"
                {...menuHandlers(`${name(group.path)} project actions`, projectActions(group.path))}
              >
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
              </div>
              <div hidden={collapsed[group.path]}>
                {group.workspaces.filter((item) => !item.pinned).map(renderWorkspace)}
                {state?.operations
                  .filter(
                    (op) =>
                      op.repositoryPath === group.path && !op.workspaceId && op.phase !== "ready",
                  )
                  .map((op) => (
                    <button
                      key={op.id}
                      className="empty-session-list"
                      onClick={() => {
                        setOperationId(op.id);
                        setSettings(undefined);
                      }}
                    >
                      {op.name} · {op.phase}
                    </button>
                  ))}
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
              <strong className="workspace-heading">
                {operationId ? operation?.name : (workspace?.name ?? "Kairo")}
              </strong>
              <div
                className="terminal-tabs"
                role="tablist"
                aria-label="Terminal tabs"
                onKeyDown={navigateTabs}
              >
                {projectTabs.map((terminal) => (
                  <button
                    key={terminal.id}
                    data-session-id={terminal.sessionId}
                    disabled={pending || !!workspace?.archivedAt || !!workspace?.unavailable}
                    role="tab"
                    aria-selected={terminal.id === activeTerminalId}
                    tabIndex={terminal.id === activeTerminalId ? 0 : -1}
                    aria-controls={`terminal-view-${terminal.id}`}
                    title={terminal.directory}
                    {...menuHandlers(
                      `${terminal.title} tab actions`,
                      terminal.sessionId
                        ? agentActions(terminal.sessionId)
                        : [
                            {
                              label: "Close terminal",
                              disabled: pending,
                              run: () =>
                                void action(async () => {
                                  await window.kairo.closeTerminal(terminal.id);
                                  return window.kairo.bootstrap(true);
                                }),
                            },
                          ],
                    )}
                    onClick={() => {
                      selectionVersion.current++;
                      if (terminal.sessionId) {
                        setShellId(undefined);
                        void action(() => window.kairo.openSession(terminal.sessionId!));
                      } else {
                        setShellId(terminal.id);
                        void window.kairo
                          .rememberWorkspaceTab(terminal.workspaceId, `terminal:${terminal.id}`)
                          .catch((cause) => setError(message(cause)));
                      }
                    }}
                  >
                    {terminal.sessionId
                      ? (state?.sessions.find((s) => s.id === terminal.sessionId)?.title ??
                        terminal.title)
                      : `Terminal ${projectTabs.filter((t) => !t.sessionId).findIndex((t) => t.id === terminal.id) + 1}`}
                  </button>
                ))}
                {stoppedSessions.map((session) => (
                  <button
                    key={session.id}
                    data-session-id={session.id}
                    disabled={pending || !!workspace?.archivedAt || !!workspace?.unavailable}
                    {...menuHandlers(`${session.title} tab actions`, agentActions(session.id))}
                    role="tab"
                    aria-selected={session.id === current?.id && !selectedShell}
                    tabIndex={session.id === current?.id ? 0 : -1}
                    onClick={() => {
                      selectionVersion.current++;
                      void action(() => window.kairo.openSession(session.id));
                    }}
                  >
                    {session.title} · stopped
                  </button>
                ))}
              </div>
              <div className="terminal-tab-actions">
                <button
                  aria-label="New terminal tab"
                  disabled={
                    !workspace ||
                    !!workspace.removedAt ||
                    !!workspace.archivedAt ||
                    !!workspace.unavailable ||
                    creatingShell
                  }
                  onClick={() => void newShell()}
                >
                  + Terminal
                </button>
                <button
                  aria-label="New agent tab"
                  disabled={
                    pending || !workspace || !!workspace.archivedAt || !!workspace.unavailable
                  }
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
                {tab === "archived" ? "Archived" : tab[0].toUpperCase() + tab.slice(1)}
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
              <h2>Archived workspaces</h2>
              {state?.workspaces
                .filter((w) => w.archivedAt && !w.removedAt)
                .map((w) => (
                  <article key={w.id} className="workspace-catalog-row">
                    <div>
                      <strong>{w.name}</strong>
                      <code>{w.directory}</code>
                    </div>
                    <button onClick={() => void action(() => window.kairo.restoreWorkspace(w.id))}>
                      Restore workspace
                    </button>
                  </article>
                ))}
              <h2>Archived sessions</h2>
              {archived.map((session) => (
                <article className="workspace-catalog-row" key={session.id}>
                  <div>
                    <strong>{session.title}</strong>
                    <code>
                      {state?.workspaces.find((item) => item.id === session.workspaceId)?.directory}
                    </code>
                  </div>
                  <button
                    disabled={
                      pending ||
                      !!state?.workspaces.find((item) => item.id === session.workspaceId)?.removedAt
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
              {!archived.length && <p className="empty-small">No archived sessions</p>}
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
                      <strong>{item.name ?? item.branch ?? name(item.directory)}</strong>
                      <small>{item.kind}</small>
                      <code>{item.directory}</code>
                    </div>
                    <button
                      disabled={pending}
                      onClick={() => {
                        setSettings(undefined);
                        void action(() =>
                          item.archivedAt
                            ? window.kairo
                                .restoreWorkspace(item.id)
                                .then(() => window.kairo.selectWorkspace(item.id))
                            : window.kairo.selectWorkspace(item.id),
                        );
                      }}
                    >
                      Open
                    </button>
                    {item.managed && (
                      <button
                        className="danger-outline-button"
                        disabled={
                          pending ||
                          (!item.archivedAt &&
                            state.sessions.some((session) => session.workspaceId === item.id)) ||
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
              activeTerminalId={
                settings || workspace?.archivedAt || operationId ? undefined : activeTerminalId
              }
              onError={onError}
            />
          </Suspense>
          {operation && !workspace?.archivedAt && (
            <div className="preparation-panel" role="status">
              <h2>
                {operation.name} · {operation.phase}
              </h2>
              {operation.error && <p className="file-error">{operation.error}</p>}
              {preparationOutput && <pre>{preparationOutput}</pre>}
              <div className="modal-actions">
                {["checkout", "copy", "setup"].includes(operation.phase) ? (
                  <button
                    onClick={() => void action(() => window.kairo.cancelPreparation(operation.id))}
                  >
                    Cancel preparation
                  </button>
                ) : (
                  operation.phase !== "ready" && (
                    <button
                      onClick={() => void action(() => window.kairo.retryPreparation(operation.id))}
                    >
                      Retry preparation
                    </button>
                  )
                )}
                {operation.workspaceId && (
                  <button
                    onClick={() => {
                      setOperationId(undefined);
                      void chooseWorkspace(operation.workspaceId!);
                    }}
                  >
                    Open workspace
                  </button>
                )}
              </div>
            </div>
          )}
          {!activeTerminalId && !operationId && (
            <div className="welcome">
              <KairoLogo className="welcome-logo" />
              <h1>
                {workspace?.archivedAt
                  ? "Workspace archived"
                  : current
                    ? "Agent terminal stopped"
                    : workspace
                      ? "Start an agent session"
                      : "Open your project"}
              </h1>
              <p>
                {workspace?.archivedAt
                  ? "Restore this workspace to open its agent and terminal tabs. Your files and session history are kept."
                  : current
                    ? "Your workspace and session association are saved."
                    : "Choose an installed agent and work in its terminal inside Kairo."}
              </p>
              <button
                className="primary"
                disabled={
                  pending ||
                  !!workspace?.unavailable ||
                  (!!operation && ["checkout", "copy", "setup"].includes(operation.phase))
                }
                onClick={() =>
                  workspace?.archivedAt
                    ? void action(() => window.kairo.restoreWorkspace(workspace.id))
                    : current
                      ? void action(() => window.kairo.startSession(current.id))
                      : workspace
                        ? beginSession()
                        : void action(() => window.kairo.openWorkspace())
                }
              >
                {workspace?.archivedAt
                  ? "Restore workspace"
                  : current
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
                target={target?.workspaceId === workspace.id ? target : undefined}
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
                  if (workspace) setTarget({ path, nonce: Date.now(), workspaceId: workspace.id });
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
      {rowMenu && (
        <ContextMenu
          key={`${rowMenu.x}:${rowMenu.y}:${rowMenu.label}`}
          menu={rowMenu}
          close={closeRowMenu}
        />
      )}
      {workspaceDialog !== undefined && state && (
        <WorkspaceDialog
          initialProject={workspaceDialog}
          state={state}
          apply={(value) => {
            apply(value);
            const op = value.operations.find(
              (op) => !state.operations.some((old) => old.id === op.id),
            );
            if (op) setOperationId(op.id);
          }}
          close={() => setWorkspaceDialog(undefined)}
        />
      )}
      {projectSettings && (
        <ProjectSettings project={projectSettings} close={() => setProjectSettings(undefined)} />
      )}
      {palette && state && (
        <WorkspacePalette
          kind={palette}
          state={state}
          workspace={workspace}
          close={() => setPalette(undefined)}
          select={(id, tab) => void chooseWorkspace(id, tab)}
          file={(path) => {
            setContextTab("files");
            setContextOpen(true);
            if (workspace) setTarget({ path, nonce: Date.now(), workspaceId: workspace.id });
          }}
        />
      )}
      {newOpen && (
        <ModalFrame
          labelledBy="new-session-title"
          blocked={pending}
          onDismiss={() => setNewOpen(false)}
        >
          <div className="new-session-dialog">
            <h2 id="new-session-title">New agent session</h2>
            <p className="empty-small">
              New agent tab in {workspace?.name}. Files and Git state are shared with this
              workspace’s other tabs.
            </p>
            {agentPicker}
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
                  !workspace ||
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
              void action(() =>
                rename.workspace
                  ? window.kairo.renameWorkspace(rename.id, rename.title)
                  : window.kairo.renameSession(rename.id, rename.title),
              ).then(() => setRename(undefined));
            }}
          >
            <h2 id="rename-title">Rename {rename.workspace ? "workspace" : "session"}</h2>
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
