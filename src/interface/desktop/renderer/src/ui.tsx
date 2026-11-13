import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopBootstrap,
  TaskWorkspace,
  ReviewScope,
  WorkspaceReview,
  WorkspaceTerminal,
} from "../../shared/api.js";
import { Icon, KairoLogo } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import {
  closeLeaf,
  leaf,
  leafForWorkspace,
  leaves,
  openBeside,
  prune,
  setPaneWorkspace,
  type Leaf,
  type PaneNode,
} from "./pane-layout.js";
import { usePaneSlots, type Rect } from "./pane-slots.js";
import { SplitLayout } from "./split-layout.js";
import { SecondaryPane } from "./secondary-pane.js";
import { DropZones, type DropZone } from "./drop-zones.js";
import { X } from "lucide-react";
import { ZoomIndicator } from "./zoom-indicator.js";
import { WindowControls } from "./window-controls.js";
import { shellLabels } from "./terminal-label.js";
import { TopbarActions } from "./topbar-actions.js";
import { WorkspaceTitle } from "./workspace-title.js";
import { TerminalTabs } from "./terminal-tabs.js";
import { activityClass, activityLabel } from "./activity.js";
import { Sidebar } from "./sidebar.js";
import { SettingsContent, SettingsNav } from "./settings-screen.js";
import { AgentPicker, ConfirmDialog, NewSessionDialog, RenameDialog } from "./session-dialogs.js";
import { HomeScreen } from "./home-screen.js";
import { rememberedShell, openWorkspaceShell } from "./workspace-selection.js";
import { WorkspaceDialog, ProjectSettings } from "./workspace-dialog.js";
import { WorkspacePalette, type PaletteCommand } from "./workspace-palette.js";
import { ContextMenu, type ContextAction, type ContextMenuState } from "./context-menu.js";
const AgentTerminals = lazy(() => import("./agent-terminals.js"));
const FileBrowser = lazy(() => import("./file-browser.js"));
const ReviewPanel = lazy(() => import("./review-panel.js"));
import type { ThemeChoice } from "./settings-screen.js";
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
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => {
    const saved = localStorage.getItem("kairo-theme");
    return saved === "light" || saved === "system" ? saved : "dark";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme = themeChoice === "system" ? (systemDark ? "dark" : "light") : themeChoice;
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
  const [settings, setSettings] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [workspaceDialog, setWorkspaceDialog] = useState<string>();
  const [projectSettings, setProjectSettings] = useState<string>();
  const [palette, setPalette] = useState<"jump" | "file">();
  const [operationId, setOperationId] = useState<string>();
  const [overview, setOverview] = useState<WorkspaceReview>();
  const [reviewError, setReviewError] = useState("");
  const [scope, setScope] = useState<ReviewScope>("task");
  const [revision, setRevision] = useState(0);
  const [target, setTarget] = useState<{ path: string; nonce: number; workspaceId: string }>();
  const [newOpen, setNewOpen] = useState(false);
  const [agentId, setAgentId] = useState(localStorage.getItem("kairo-last-agent") ?? "codex");
  const [agentQuery, setAgentQuery] = useState("");
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [rename, setRename] = useState<{
    id: string;
    title: string;
    workspace?: boolean;
    terminal?: boolean;
  }>();
  const [rowMenu, setRowMenu] = useState<ContextMenuState>();
  const shellWhenReady = useRef<string | undefined>(undefined);
  const [layout, setLayout] = useState<PaneNode>();
  const [dragging, setDragging] = useState<string>();
  const [paneTabs, setPaneTabs] = useState<Record<string, string>>({});
  const { area: paneArea, rects, register } = usePaneSlots();
  const blankLeaf = useMemo(() => leaf(""), []);
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
  // Plain shells live in the sidebar, so the top bar only has tabs for agents.
  const agentTabs = projectTabs.filter((t) => t.sessionId);
  // Agents running in one checkout share its files, so their edits can collide.
  const runningAgents = projectTabs.filter((t) => t.sessionId && t.state === "running").length;
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
  // A workspace with nothing running shows the Kairo chat view instead of a bare start prompt.
  const kairoView =
    !settings &&
    !activeTerminalId &&
    !operationId &&
    !operation &&
    !!workspace &&
    !workspace.archivedAt &&
    !workspace.unavailable &&
    !current;
  useEffect(() => {
    if (!settings) return;
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
  const newShell = async (id = workspace?.id, force = false) => {
    if (!id || creatingShell) return;
    setCreatingShell(true);
    setError("");
    const version = selectionVersion.current;
    try {
      await openWorkspaceShell(
        window.kairo,
        id,
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
          force ||
          (selectionVersion.current === version && stateRef.current?.activeWorkspaceId === id),
        (terminal) => {
          setShellId(terminal.id);
          setSettings(false);
        },
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setCreatingShell(false);
    }
  };
  const apply = useCallback((value: DesktopBootstrap) => setState(value), []);
  const onError = useCallback((value: string) => setError(value), []);
  const groups = useMemo(() => {
    const map = new Map<string, TaskWorkspace[]>();
    for (const path of state?.projects ?? []) map.set(path, []);
    for (const item of state?.workspaces ?? []) {
      if (item.removedAt || item.archivedAt || item.repositoryPath === state?.chatsRoot) continue;
      map.set(item.repositoryPath, [...(map.get(item.repositoryPath) ?? []), item]);
    }
    for (const op of state?.operations ?? [])
      if (!op.workspaceId && op.phase !== "ready") {
        if (!map.has(op.repositoryPath)) map.set(op.repositoryPath, []);
      }
    return [...map].map(([path, workspaces]) => ({ path, workspaces }));
  }, [state?.workspaces, state?.operations, state?.projects, state?.chatsRoot]);
  const chats = useMemo(
    () =>
      (state?.workspaces ?? []).filter(
        (item) =>
          item.repositoryPath === state?.chatsRoot &&
          !item.removedAt &&
          !item.archivedAt &&
          !item.pinned,
      ),
    [state?.workspaces, state?.chatsRoot],
  );
  const archivedChats = useMemo(
    () =>
      (state?.workspaces ?? []).filter(
        (item) => item.repositoryPath === state?.chatsRoot && item.archivedAt && !item.removedAt,
      ),
    [state?.workspaces, state?.chatsRoot],
  );
  const [settingsTab, setSettingsTab] = useState("general");
  const [selecting, setSelecting] = useState(false);
  const [pickedWorkspaces, setPickedWorkspaces] = useState<Set<string>>(new Set());
  const [pickedProjects, setPickedProjects] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };
  const stopSelecting = () => {
    setSelecting(false);
    setPickedWorkspaces(new Set());
    setPickedProjects(new Set());
  };
  const newChat = () => void action(() => window.kairo.createChat());
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
  // Opening Kairo lands on a chat in "This computer": the newest one, or a fresh Kairo chat.
  const landed = useRef(false);
  useEffect(() => {
    if (!state || landed.current) return;
    landed.current = true;
    const newest = state.workspaces.find(
      (item) =>
        item.repositoryPath === state.chatsRoot &&
        !item.removedAt &&
        !item.archivedAt &&
        !item.unavailable,
    );
    if (newest && state.activeWorkspaceId === newest.id) return;
    void action(async () =>
      newest ? window.kairo.selectWorkspace(newest.id) : window.kairo.createChat(),
    );
  }, [state, action]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("kairo-theme", themeChoice);
  }, [theme, themeChoice]);
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
    setShowAllAgents(false);
    setError("");
    setNewOpen(true);
    void refreshAgents();
  }, [refreshAgents]);
  useEffect(() => {
    if (!newOpen) return;
    const refresh = () => void refreshAgents();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [newOpen, refreshAgents]);
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
        else if (key === "n") {
          if (workspace && workspace.repositoryPath === state?.chatsRoot) newChat();
          else setWorkspaceDialog(workspace?.repositoryPath ?? "");
        } else {
          setContextTab(key === "e" ? "files" : "changes");
          setContextOpen(true);
        }
      } else if (
        event.key === "Escape" &&
        !(event.target instanceof Element && event.target.closest(".terminal-view"))
      ) {
        if (settings) setSettings(false);
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
    setSettings(false);
    await action(async () => {
      const value = await window.kairo.selectWorkspace(id);
      if (tab?.startsWith("session:")) return window.kairo.openSession(tab.slice(8));
      if (tab?.startsWith("terminal:")) await window.kairo.rememberWorkspaceTab(id, tab);
      return tab ? window.kairo.bootstrap(true) : value;
    });
  };
  /** A plain shell for a project: in one of its workspaces, or in a shared folder workspace. */
  const projectTerminal = async (path: string) => {
    const own = state?.workspaces.find(
      (item) =>
        item.repositoryPath === path && !item.removedAt && !item.archivedAt && !item.unavailable,
    );
    setError("");
    try {
      let id = own?.id;
      if (id) await chooseWorkspace(id);
      else {
        const value = await window.kairo.createWorkspace({
          project: path,
          name: name(path),
          selection: { kind: "folder" },
        });
        apply(value);
        id = value.activeWorkspaceId;
      }
      if (id) await newShell(id, true);
    } catch (cause) {
      setError(message(cause));
    }
  };
  // Once a new workspace finishes preparing there is nothing left to confirm, so open it directly.
  const readyWorkspaceId =
    operation?.id === operationId && operation?.phase === "ready" && !operation?.error
      ? operation?.workspaceId
      : undefined;
  useEffect(() => {
    if (!readyWorkspaceId) return;
    const wantsShell = shellWhenReady.current === operationId;
    void (async () => {
      await chooseWorkspace(readyWorkspaceId);
      if (!wantsShell) return;
      shellWhenReady.current = undefined;
      await newShell(readyWorkspaceId, true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyWorkspaceId]);
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
  const workspaceActivity = (id: string): keyof typeof activityLabel => {
    const open = state?.terminals.filter((t) => t.workspaceId === id && t.state === "running");
    if (!open?.length) return "none";
    if (open.some((t) => t.activity === "waiting")) return "waiting";
    if (open.some((t) => t.activity === "working")) return "working";
    return "idle";
  };
  const projectActions = (path: string): ContextAction[] => [
    { label: "New workspace", disabled: pending, run: () => setWorkspaceDialog(path) },
    {
      label: "Delete project",
      disabled: pending,
      run: () => {
        const count =
          state?.workspaces.filter(
            (item) => item.repositoryPath === path && !item.removedAt && !item.archivedAt,
          ).length ?? 0;
        setConfirm({
          title: "Delete project?",
          description: count
            ? `Delete ${name(path)} and its ${count} ${count === 1 ? "workspace" : "workspaces"}. Terminals close and worktree folders are removed, and Git refuses while a worktree has uncommitted files or unmerged commits. Shared project folders stay on disk.`
            : `Remove ${name(path)} from Kairo. Its folder stays on disk.`,
          action: () => window.kairo.removeProject(path).then(apply),
        });
      },
    },
  ];
  const isChat = (item: TaskWorkspace) => item.repositoryPath === state?.chatsRoot;
  const deleteWorkspace = (item: TaskWorkspace) =>
    setConfirm({
      title: isChat(item) ? "Delete chat?" : "Delete workspace?",
      description: isChat(item)
        ? "Close its terminals and delete this chat with its scratch folder. This cannot be undone."
        : item.managed
          ? "Close its terminals and remove this worktree folder. Git keeps the branch and refuses removal while uncommitted files or unmerged commits remain."
          : "Close its terminals and remove this workspace from Kairo. The folder stays on disk.",
      action: () => window.kairo.deleteWorkspace(item.id).then(apply),
    });
  /** Rename, pin, archive and delete are shared by the row menu and the command palette. */
  const workspaceCommands = (item: TaskWorkspace): ContextAction[] => {
    const label = item.name ?? item.branch ?? name(item.directory);
    return [
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
        run: () =>
          setConfirm({
            title: "Archive workspace?",
            description:
              "Close this workspace’s terminals and hide it. Files, branches, and agent session identities are kept. Restore it from Settings.",
            action: () => window.kairo.archiveWorkspace(item.id).then(apply),
          }),
      },
      { label: "Delete", disabled: pending, run: () => deleteWorkspace(item) },
    ];
  };
  const agentActions = (id: string): ContextAction[] => {
    const session = state?.sessions.find((session) => session.id === id);
    return session
      ? [
          {
            label: "Rename",
            disabled: pending,
            run: () => setRename({ id, title: session.title }),
          },
          {
            label: "Close",
            disabled: pending,
            run: () => void action(() => window.kairo.archiveSession(id)),
          },
        ]
      : [];
  };
  const selectTerminal = (terminal: WorkspaceTerminal) =>
    void chooseWorkspace(terminal.workspaceId, `terminal:${terminal.id}`);
  const shellNames = useMemo(() => shellLabels(state?.terminals ?? []), [state?.terminals]);
  /** Plain shells: rename, and close (which stops the shell, so the sidebar asks first). */
  const shellActions = (terminal: WorkspaceTerminal, ask = false): ContextAction[] => {
    const label = shellNames.get(terminal.id) ?? terminal.title;
    const close = () =>
      action(async () => {
        await window.kairo.closeTerminal(terminal.id);
        return window.kairo.bootstrap(true);
      });
    return [
      {
        label: "Rename",
        disabled: pending,
        run: () => setRename({ id: terminal.id, title: label, terminal: true }),
      },
      {
        label: ask ? "Delete" : "Close terminal",
        disabled: pending,
        run: () =>
          ask
            ? setConfirm({
                title: "Delete terminal?",
                description: `Stop “${label}” and anything running in it. Its output is not kept.`,
                action: async () => {
                  await window.kairo.closeTerminal(terminal.id);
                  apply(await window.kairo.bootstrap(true));
                },
              })
            : void close(),
      },
    ];
  };
  /** Workspaces covered by the selection: picked ones plus everything inside picked projects. */
  const bulkTargets = () => {
    const inProjects = (state?.workspaces ?? []).filter(
      (item) => !item.removedAt && pickedProjects.has(item.repositoryPath),
    );
    const direct = (state?.workspaces ?? []).filter(
      (item) => pickedWorkspaces.has(item.id) && !pickedProjects.has(item.repositoryPath),
    );
    return { inProjects, direct };
  };
  const pickedCount = pickedWorkspaces.size + pickedProjects.size;
  const bulk = (kind: "archive" | "delete") => {
    const { inProjects, direct } = bulkTargets();
    const run = async () => {
      const failures: string[] = [];
      let last: DesktopBootstrap | undefined;
      const each = async (items: TaskWorkspace[]) => {
        for (const item of items) {
          if (kind === "archive" && item.archivedAt) continue;
          try {
            last =
              kind === "archive"
                ? await window.kairo.archiveWorkspace(item.id)
                : await window.kairo.deleteWorkspace(item.id);
          } catch (cause) {
            failures.push(`${item.name ?? name(item.directory)}: ${message(cause)}`);
          }
        }
      };
      await each(direct);
      await each(inProjects);
      if (kind === "delete" && !failures.length)
        for (const path of pickedProjects) last = await window.kairo.removeProject(path);
      stopSelecting();
      if (failures.length) throw new Error(failures.join(" "));
      return last;
    };
    if (kind === "archive") return void action(run);
    const projects = pickedProjects.size;
    const workspaces = direct.length + inProjects.length;
    setConfirm({
      title: "Delete selected?",
      description: `Delete ${projects ? `${projects} ${projects === 1 ? "project" : "projects"} and ` : ""}${workspaces} ${workspaces === 1 ? "workspace or chat" : "workspaces and chats"}. Terminals close, chats and worktree folders are removed (Git refuses worktrees with uncommitted or unmerged work), and project folders stay on disk. This cannot be undone.`,
      action: async () => {
        try {
          const value = await run();
          if (value) apply(value);
        } catch (cause) {
          apply(await window.kairo.bootstrap(true));
          throw cause;
        }
      },
    });
  };
  // Back and forward walk through the workspaces visited, like a browser.
  const history = useRef({ stack: [] as string[], index: -1 });
  const [, setHistoryTick] = useState(0);
  useEffect(() => {
    const current = state?.activeWorkspaceId;
    if (!current) return;
    const visited = history.current;
    if (visited.stack[visited.index] === current) return;
    visited.stack = [...visited.stack.slice(0, visited.index + 1), current];
    visited.index = visited.stack.length - 1;
    setHistoryTick((tick) => tick + 1);
  }, [state?.activeWorkspaceId]);
  const historyTarget = (delta: -1 | 1) => {
    const visited = history.current;
    const alive = (id: string) =>
      state?.workspaces.some((item) => item.id === id && !item.removedAt && !item.archivedAt);
    for (let at = visited.index + delta; at >= 0 && at < visited.stack.length; at += delta)
      if (alive(visited.stack[at])) return at;
    return undefined;
  };
  const stepHistory = (delta: -1 | 1) => {
    const at = historyTarget(delta);
    if (at === undefined) return;
    history.current.index = at;
    setHistoryTick((tick) => tick + 1);
    void chooseWorkspace(history.current.stack[at]);
  };
  // Panes: a tree of workspaces shown side by side. The active workspace's pane gets the full UI.
  const activeId = state?.activeWorkspaceId;
  const previousActive = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const live = (id: string) =>
      state.workspaces.some((item) => item.id === id && !item.removedAt && !item.archivedAt);
    setLayout((current) => {
      let next = current ? prune(current, live) : undefined;
      if (activeId && live(activeId)) {
        if (!next) next = leaf(activeId);
        else if (!leafForWorkspace(next, activeId)) {
          const from = previousActive.current
            ? leafForWorkspace(next, previousActive.current)
            : undefined;
          next = setPaneWorkspace(next, (from ?? leaves(next)[0]).id, activeId);
        }
      }
      return next;
    });
    previousActive.current = activeId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.workspaces, activeId]);
  const root = layout ?? blankLeaf;
  const paneLeaves = leaves(root);
  const primaryLeafId =
    (workspace ? leafForWorkspace(root, workspace.id)?.id : undefined) ?? paneLeaves[0].id;
  const paneTerminal = (item: Leaf) => {
    const own = state?.terminals.filter((t) => t.workspaceId === item.workspaceId) ?? [];
    return (
      own.find((t) => t.id === paneTabs[item.id]) ??
      own.find((t) => t.sessionId && t.state === "running") ??
      own[0]
    );
  };
  const placements: Record<string, Rect | undefined> = {};
  for (const item of paneLeaves) {
    const terminalId =
      item.id === primaryLeafId
        ? settings || workspace?.archivedAt || operationId
          ? undefined
          : activeTerminalId
        : paneTerminal(item)?.id;
    if (terminalId) placements[terminalId] = rects[item.id];
  }
  const focusPane = (item: Leaf) => {
    if (item.id === primaryLeafId || pending) return;
    const tab = paneTerminal(item);
    void chooseWorkspace(
      item.workspaceId,
      tab ? (tab.sessionId ? `session:${tab.sessionId}` : `terminal:${tab.id}`) : undefined,
    );
  };
  const closePane = (leafId: string) => {
    const next = closeLeaf(root, leafId);
    if (!next) return;
    setLayout(next);
    if (leafId === primaryLeafId) void chooseWorkspace(leaves(next)[0].workspaceId);
  };
  const dropOn = (item: Leaf, zone: DropZone) => {
    const id = dragging;
    setDragging(undefined);
    if (!id || id === item.workspaceId) return;
    setLayout(
      zone === "center" ? setPaneWorkspace(root, item.id, id) : openBeside(root, item.id, zone, id),
    );
    void chooseWorkspace(id);
  };
  const closeButton = (item: Leaf) =>
    paneLeaves.length > 1 && (
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-md text-muted-foreground"
        aria-label="Close pane"
        title="Close pane"
        onClick={() => closePane(item.id)}
      >
        <X />
      </Button>
    );
  /** With one tab the strip is hidden, so that tab's actions live in the title menu instead. */
  const onlyTab = agentTabs.length + stoppedSessions.length === 1;
  const loneTerminal = onlyTab ? agentTabs[0] : undefined;
  const loneSession = onlyTab ? stoppedSessions[0] : undefined;
  const loneActions: ContextAction[] = (
    loneSession
      ? agentActions(loneSession.id)
      : loneTerminal?.sessionId
        ? agentActions(loneTerminal.sessionId)
        : loneTerminal
          ? [
              {
                label: "Close",
                disabled: pending,
                run: () =>
                  void action(async () => {
                    await window.kairo.closeTerminal(loneTerminal.id);
                    return window.kairo.bootstrap(true);
                  }),
              },
            ]
          : []
  ).map((item) => ({ ...item, label: `${item.label} tab` }));
  const renderLeaf = (item: Leaf) => {
    const drop = (
      <DropZones
        active={!!dragging && dragging !== item.workspaceId}
        onDrop={(zone) => dropOn(item, zone)}
      />
    );
    const first = item.id === paneLeaves[0].id;
    if (item.id !== primaryLeafId) {
      const owner = state?.workspaces.find((w) => w.id === item.workspaceId);
      const shown = paneTerminal(item);
      return (
        <SecondaryPane
          key={item.id}
          workspace={owner}
          terminals={state?.terminals.filter((t) => t.workspaceId === item.workspaceId) ?? []}
          tabId={shown?.id}
          first={first}
          actions={owner ? workspaceCommands(owner) : undefined}
          onTab={(terminal) => setPaneTabs((tabs) => ({ ...tabs, [item.id]: terminal.id }))}
          onRename={(title) =>
            owner && void action(() => window.kairo.renameWorkspace(owner.id, title))
          }
          onFocus={() => focusPane(item)}
          onClose={() => closePane(item.id)}
        >
          <div className="pane-body relative flex min-h-0 flex-1 flex-col">
            <div className="agent-workspace" ref={register(item.id)}>
              {!shown && owner && (
                <HomeScreen
                  pending={pending}
                  storageKey={`kairo.chat:${owner.id}`}
                  location={isChat(owner) ? "This computer" : name(owner.repositoryPath)}
                  agents={installedAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
                />
              )}
            </div>
            {drop}
          </div>
        </SecondaryPane>
      );
    }
    return (
      <section
        key={item.id}
        className="pane pane-primary flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label="Active pane"
      >
        <header className={`topbar ${first ? "topbar-first" : ""}`}>
          <WorkspaceTitle
            name={
              operationId
                ? (operation?.name ?? "Kairo")
                : workspace
                  ? (workspace.name ?? workspace.branch ?? name(workspace.directory))
                  : "Kairo"
            }
            actions={
              !operationId && workspace && !workspace.removedAt
                ? [...workspaceCommands(workspace), ...loneActions]
                : undefined
            }
            status={
              loneTerminal?.state === "running" &&
              (loneTerminal.activity === "working" || loneTerminal.activity === "waiting")
                ? {
                    className: activityClass[loneTerminal.activity],
                    label: activityLabel[loneTerminal.activity],
                  }
                : undefined
            }
            disabled={pending || !!workspace?.archivedAt}
            onRename={(title) =>
              workspace && void action(() => window.kairo.renameWorkspace(workspace.id, title))
            }
          />
          <TerminalTabs
            workspace={workspace}
            state={state}
            operationId={operationId}
            runningAgents={runningAgents}
            projectTabs={agentTabs}
            stoppedSessions={stoppedSessions}
            activeTerminalId={activeTerminalId}
            current={current}
            selectedShell={selectedShell}
            pending={pending}
            menuHandlers={menuHandlers}
            agentActions={agentActions}
            shellActions={shellActions}
            shellNames={shellNames}
            action={action}
            selectionVersion={selectionVersion}
            setShellId={setShellId}
            setError={setError}
          />
          <TopbarActions
            canOpenTerminal={
              !!workspace &&
              !workspace.removedAt &&
              !workspace.archivedAt &&
              !workspace.unavailable &&
              !creatingShell
            }
            canOpenTab={!pending && !!workspace && !workspace.archivedAt && !workspace.unavailable}
            canOpenPanel={!!accessId && !workspace?.removedAt}
            panelTab={contextOpen ? contextTab : undefined}
            changeCount={overview?.changes.length ?? 0}
            onTerminal={() => void newShell()}
            onAgent={() => beginSession()}
            onPanel={(tab) => {
              setContextTab(tab);
              setContextOpen(!(contextOpen && contextTab === tab));
            }}
          />
          {closeButton(item)}
        </header>
        <div className="pane-body relative flex min-h-0 flex-1 flex-col">
          <div className="agent-workspace" ref={register(item.id)}>
            {operation && !workspace?.archivedAt && (
              <div className="preparation-panel" role="status">
                <h2>
                  {operation.name} · {operation.phase}
                </h2>
                {operation.error && <p className="file-error">{operation.error}</p>}
                {preparationOutput && <pre>{preparationOutput}</pre>}
                <div className="modal-actions">
                  {["checkout", "copy", "setup"].includes(operation.phase) ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void action(() => window.kairo.cancelPreparation(operation.id))
                      }
                    >
                      Cancel preparation
                    </Button>
                  ) : (
                    operation.phase !== "ready" && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          void action(() => window.kairo.retryPreparation(operation.id))
                        }
                      >
                        Retry preparation
                      </Button>
                    )
                  )}
                  {operation.workspaceId && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setOperationId(undefined);
                        void chooseWorkspace(operation.workspaceId!);
                      }}
                    >
                      Open workspace
                    </Button>
                  )}
                </div>
              </div>
            )}
            {kairoView && workspace && (
              <HomeScreen
                pending={pending}
                storageKey={`kairo.chat:${workspace.id}`}
                location={isChat(workspace) ? "This computer" : name(workspace.repositoryPath)}
                agents={installedAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
              />
            )}
            {!activeTerminalId && !operationId && !workspace && !groups.length && (
              <HomeScreen
                pending={pending}
                agents={installedAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
                onOpenProject={() => void action(() => window.kairo.openWorkspace())}
                onNewChat={newChat}
              />
            )}
            {!activeTerminalId &&
              !operationId &&
              !kairoView &&
              (workspace || groups.length > 0) && (
                <div className="welcome">
                  <KairoLogo className="welcome-logo" />
                  <h1>
                    {workspace?.archivedAt
                      ? "Workspace archived"
                      : current
                        ? "Agent terminal stopped"
                        : workspace
                          ? "Start an agent session"
                          : "Choose a workspace"}
                  </h1>
                  <p>
                    {workspace?.archivedAt
                      ? "Restore this workspace to open its agent and terminal tabs. Your files and session history are kept."
                      : current
                        ? "Your workspace and session association are saved."
                        : workspace
                          ? "Choose an installed agent and work in its terminal inside Kairo."
                          : "Pick one in the sidebar, or press + beside a project to create one."}
                  </p>
                  {workspace && (
                    <Button
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
                            : beginSession()
                      }
                    >
                      {workspace?.archivedAt
                        ? "Restore workspace"
                        : current
                          ? "Open agent terminal"
                          : "New agent session"}
                    </Button>
                  )}
                </div>
              )}
          </div>
          {drop}
        </div>
      </section>
    );
  };
  const renderWorkspace = (item: TaskWorkspace) => {
    const op = state?.operations.find((op) => op.workspaceId === item.id);
    const label = item.name ?? item.branch ?? name(item.directory);
    const activity = workspaceActivity(item.id);
    const agents = [
      ...new Set(
        (state?.sessions ?? [])
          .filter((session) => session.workspaceId === item.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(
            (session) =>
              state?.agents.find((agent) => agent.id === session.agentId)?.name ?? session.agentId,
          ),
      ),
    ];
    // Opening a workspace from the sidebar shows its agent, not whichever shell was last open.
    const lastSession = (state?.sessions ?? [])
      .filter((session) => session.workspaceId === item.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const agentTab = lastSession ? `session:${lastSession.id}` : undefined;
    const agentLabel = agents.length > 1 ? `${agents[0]} +${agents.length - 1}` : agents[0];
    const note = item.unavailable
      ? "Unavailable"
      : op && op.phase !== "ready"
        ? op.phase
        : activity === "waiting"
          ? "Waiting for you"
          : undefined;
    return (
      <div
        key={item.id}
        data-workspace-id={item.id}
        className={`session-row workspace-row ${workspace?.id === item.id ? "selected" : ""}`}
        {...menuHandlers(`${label} actions`, workspaceCommands(item))}
        draggable={!selecting && !pending}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-kairo-workspace", item.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging(item.id);
        }}
        onDragEnd={() => setDragging(undefined)}
      >
        {selecting && (
          <input
            type="checkbox"
            className="select-box"
            aria-label={`Select ${label}`}
            checked={pickedWorkspaces.has(item.id) || pickedProjects.has(item.repositoryPath)}
            disabled={pickedProjects.has(item.repositoryPath)}
            onChange={() => setPickedWorkspaces((set) => toggle(set, item.id))}
          />
        )}
        <button
          className="session"
          aria-current={workspace?.id === item.id ? "page" : undefined}
          disabled={pending}
          onClick={() =>
            selecting
              ? setPickedWorkspaces((set) => toggle(set, item.id))
              : void chooseWorkspace(item.id, agentTab)
          }
        >
          <span
            className={`session-status ${item.unavailable ? "status-error" : activityClass[activity]}`}
            title={item.unavailable ? "Unavailable" : activityLabel[activity]}
          />
          <span className="session-labels">
            <span className="session-title">{label}</span>
            {/* The branch or folder kind is not repeated here; only states that need attention. */}
            {note && <small className="session-workspace-label">{note}</small>}
          </span>
          {agentLabel && <small className="session-agent">{agentLabel}</small>}
        </button>
      </div>
    );
  };
  const commands: PaletteCommand[] = [
    ...(workspace && !workspace.removedAt
      ? [
          ...workspaceCommands(workspace)
            .filter((command) => !command.disabled)
            .map((command) => ({
              label: `${command.label} workspace`,
              detail: workspace.name ?? workspace.branch ?? name(workspace.directory),
              run: command.run,
            })),
          ...(workspace.repositoryPath === state?.chatsRoot
            ? []
            : [
                {
                  label: "Project setup",
                  detail: `Setup script and files to copy · ${name(workspace.repositoryPath)}`,
                  run: () => setProjectSettings(workspace.repositoryPath),
                },
              ]),
        ]
      : []),
    workspace && workspace.repositoryPath === state?.chatsRoot
      ? { label: "New chat", run: newChat }
      : { label: "New workspace", run: () => setWorkspaceDialog(workspace?.repositoryPath ?? "") },
    { label: "Open project folder", run: () => void action(() => window.kairo.openWorkspace()) },
    { label: "Settings", run: () => setSettings(true) },
    {
      label: "Keyboard shortcuts",
      run: () => {
        setSettingsTab("shortcuts");
        setSettings(true);
      },
    },
    ...(["system", "dark", "light"] as const).map((choice) => ({
      label: `Theme: ${choice[0].toUpperCase()}${choice.slice(1)}`,
      run: () => setThemeChoice(choice),
    })),
  ];
  const installedAgents = state?.agents.filter((agent) => agent.installed) ?? [];
  const listAll = showAllAgents || (!detecting && !installedAgents.length);
  const agentPicker = () => (
    <AgentPicker
      agents={state?.agents ?? []}
      installed={installedAgents}
      listAll={listAll}
      detecting={detecting}
      agentId={agentId}
      query={agentQuery}
      showAll={showAllAgents}
      onAgent={setAgentId}
      onQuery={setAgentQuery}
      onToggleAll={() => setShowAllAgents((value) => !value)}
      onInstall={(id) =>
        void window.kairo.openAgentHomepage(id).catch((cause) => setError(message(cause)))
      }
    />
  );
  return (
    <div
      className={`app-shell ${contextOpen && !settings && accessId && workspace ? "review-open" : ""} ${sidebarOpen ? "" : "sidebar-closed"}`}
      data-theme={theme}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--context-width": `${contextWidth}px`,
        } as React.CSSProperties
      }
    >
      <SettingsNav
        hidden={!sidebarOpen || !settings}
        tab={settingsTab}
        onTab={setSettingsTab}
        onBack={() => setSettings(false)}
      />
      <WindowControls
        sidebarOpen={sidebarOpen}
        canBack={historyTarget(-1) !== undefined}
        canForward={historyTarget(1) !== undefined}
        onToggle={() => setSidebarOpen((value) => !value)}
        onBack={() => stepHistory(-1)}
        onForward={() => stepHistory(1)}
      />
      <Sidebar
        hidden={!sidebarOpen || settings}
        pending={pending}
        state={state}
        groups={groups}
        chats={chats}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        selecting={selecting}
        setSelecting={setSelecting}
        stopSelecting={stopSelecting}
        pickedProjects={pickedProjects}
        setPickedProjects={setPickedProjects}
        pickedCount={pickedCount}
        toggle={toggle}
        bulk={bulk}
        renderWorkspace={renderWorkspace}
        menuHandlers={menuHandlers}
        projectActions={projectActions}
        action={action}
        newChat={newChat}
        onProjectTerminal={(path) => void projectTerminal(path)}
        terminals={state?.terminals.filter((terminal) => !terminal.sessionId) ?? []}
        shellNames={shellNames}
        activeTerminalId={workspace?.id ? activeTerminalId : undefined}
        selectTerminal={selectTerminal}
        shellActions={(terminal) => shellActions(terminal, true)}
        setWorkspaceDialog={setWorkspaceDialog}
        setOperationId={setOperationId}
        setSettings={setSettings}
      />
      {sidebarOpen && resizeHandle("sidebar")}
      <main className="conversation">
        {settings && (
          <header className="topbar topbar-first">
            <strong>Settings</strong>
            <Button variant="ghost" size="sm" onClick={() => setSettings(false)}>
              Back to workspace
            </Button>
          </header>
        )}
        {error && (
          <div className="desktop-error" role="alert">
            {error}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              ×
            </Button>
          </div>
        )}
        <SettingsContent
          hidden={!settings}
          tab={settingsTab}
          theme={themeChoice}
          onTheme={setThemeChoice}
          state={state}
          archived={archived}
          archivedChats={archivedChats}
          pending={pending}
          isChat={isChat}
          run={action}
          apply={apply}
          confirm={setConfirm}
          deleteWorkspace={deleteWorkspace}
          closeSettings={() => setSettings(false)}
        />
        <div
          ref={paneArea}
          className={`pane-area relative flex min-h-0 flex-1 ${dragging ? "dragging" : ""}`}
          hidden={!!settings}
        >
          <div className="flex min-h-0 min-w-0 flex-1">
            <SplitLayout
              node={root}
              onResize={(next) => setLayout((current) => next(current ?? root))}
              renderLeaf={renderLeaf}
            />
          </div>
          <Suspense fallback={null}>
            <AgentTerminals
              terminals={state?.terminals ?? []}
              placements={placements}
              focusedId={activeTerminalId}
              onError={onError}
            />
          </Suspense>
        </div>
      </main>

      {contextOpen && !settings && accessId && workspace && (
        <aside className="workbench" id="workspace-panel" aria-label="Workspace files and review">
          {resizeHandle("context")}
          <header className="workbench-header">
            <Tabs
              className="context-tab-list flex flex-1"
              value={contextTab}
              onValueChange={(tab) => setContextTab(tab as "files" | "changes")}
            >
              <TabsList aria-label="Workspace tabs">
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="changes">Review</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              size="icon"
              className="icon-button size-[30px] rounded-md text-muted-foreground"
              aria-label="Close workspace panel"
              onClick={() => setContextOpen(false)}
            >
              <Icon name="close" />
            </Button>
          </header>
          <Suspense fallback={<p className="empty-small">Loading workspace…</p>}>
            {contextTab === "files" ? (
              <FileBrowser
                key={workspace.id}
                sessionId={accessId}
                changes={overview?.changes ?? []}
                revision={revision}
                target={target?.workspaceId === workspace.id ? target : undefined}
              />
            ) : (
              <ReviewPanel
                key={workspace.id}
                sessionId={accessId}
                workspaceId={workspace.id}
                overview={overview}
                error={reviewError}
                scope={scope}
                canReviewTask={!!workspace.baseCommit}
                revision={revision}
                onScope={setScope}
              />
            )}
          </Suspense>
        </aside>
      )}
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
          apply={(value, options) => {
            apply(value);
            const op = value.operations.find(
              (op) => !state.operations.some((old) => old.id === op.id),
            );
            if (op) setOperationId(op.id);
            if (!options?.terminal) return;
            // A worktree is prepared in the background; its shell opens once it is ready.
            if (op) shellWhenReady.current = op.id;
            else if (value.activeWorkspaceId) void newShell(value.activeWorkspaceId, true);
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
          commands={commands}
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
        <NewSessionDialog
          workspace={workspace}
          isChat={workspace?.repositoryPath === state?.chatsRoot}
          runningAgents={runningAgents}
          picker={agentPicker()}
          error={error}
          pending={pending}
          canOpen={
            !pending &&
            !detecting &&
            !!workspace &&
            !!state?.agents.find((agent) => agent.id === agentId)?.installed
          }
          onClose={() => setNewOpen(false)}
          onSeparateWorkspace={() => {
            setNewOpen(false);
            if (workspace) setWorkspaceDialog(workspace.repositoryPath);
          }}
          onOpen={() => void create()}
        />
      )}
      {rename && (
        <RenameDialog
          noun={rename.terminal ? "terminal" : rename.workspace ? "workspace" : "session"}
          value={rename.title}
          pending={pending}
          onChange={(title) => setRename({ ...rename, title })}
          onClose={() => setRename(undefined)}
          onSubmit={() =>
            void action(async () => {
              if (rename.terminal) {
                await window.kairo.renameTerminal(rename.id, rename.title);
                return undefined;
              }
              return rename.workspace
                ? window.kairo.renameWorkspace(rename.id, rename.title)
                : window.kairo.renameSession(rename.id, rename.title);
            }).then(() => setRename(undefined))
          }
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          error={error}
          pending={pending}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => {
            setPending(true);
            setError("");
            void confirm
              .action()
              .then(() => setConfirm(undefined))
              .catch((cause) => setError(message(cause)))
              .finally(() => setPending(false));
          }}
        />
      )}
      <ZoomIndicator />
    </div>
  );
}
