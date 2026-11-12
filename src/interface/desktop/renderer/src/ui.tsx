import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopBootstrap,
  TaskWorkspace,
  ReviewScope,
  WorkspaceReview,
} from "../../shared/api.js";
import { Icon, KairoLogo, ModalFrame } from "./chrome.js";
import { Button } from "./components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
import { HomeScreen } from "./home-screen.js";
import { navigateTabs } from "./tab-navigation.js";
import { rememberedShell, openWorkspaceShell } from "./workspace-selection.js";
import { WorkspaceDialog, ProjectSettings } from "./workspace-dialog.js";
import { WorkspacePalette, type PaletteCommand } from "./workspace-palette.js";
import { ContextMenu, type ContextAction, type ContextMenuState } from "./context-menu.js";
const AgentTerminals = lazy(() => import("./agent-terminals.js"));
const FileBrowser = lazy(() => import("./file-browser.js"));
const ReviewPanel = lazy(() => import("./review-panel.js"));
type ThemeChoice = "system" | "dark" | "light";
const activityLabel = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  none: "No terminal open",
} as const;
const activityClass = {
  working: "status-running",
  waiting: "status-waiting",
  idle: "status-open",
  none: "",
} as const;
const settingsTabs: [string, string][] = [
  ["general", "General"],
  ["chats", "Archived chats"],
  ["workspaces", "Workspaces"],
  ["tabs", "Closed agent tabs"],
  ["shortcuts", "Keyboard shortcuts"],
];
const shortcuts: [string, string][] = [
  ["Cmd/Ctrl+Shift+N", "New workspace"],
  ["Cmd/Ctrl+J", "Jump to a workspace or tab, or run a command"],
  ["Cmd/Ctrl+P", "Quick open file"],
  ["Cmd/Ctrl+`", "New terminal tab"],
  ["Cmd/Ctrl+Shift+E", "Files"],
  ["Cmd/Ctrl+Shift+D", "Review"],
  ["Cmd/Ctrl+Shift+B", "Toggle sidebar"],
];
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
  const renderWorkspace = (item: TaskWorkspace) => {
    const op = state?.operations.find((op) => op.workspaceId === item.id);
    const label = item.name ?? item.branch ?? name(item.directory);
    const activity = workspaceActivity(item.id);
    return (
      <div
        key={item.id}
        data-workspace-id={item.id}
        className={`session-row workspace-row ${workspace?.id === item.id ? "selected" : ""}`}
        {...menuHandlers(`${label} actions`, workspaceCommands(item))}
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
              : void chooseWorkspace(item.id)
          }
        >
          <span
            className={`session-status ${item.unavailable ? "status-error" : activityClass[activity]}`}
            title={item.unavailable ? "Unavailable" : activityLabel[activity]}
          />
          <span className="session-labels">
            <span className="session-title">{label}</span>
            <small className="session-workspace-label">
              {item.unavailable
                ? "Unavailable"
                : op && op.phase !== "ready"
                  ? op.phase
                  : activity === "waiting"
                    ? "Waiting for you"
                    : (item.branch ?? item.kind)}
            </small>
          </span>
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
    <>
      {listAll && (
        <div className="agent-picker-heading">
          <input
            aria-label="Search agents"
            placeholder="Search agents…"
            value={agentQuery}
            onChange={(event) => setAgentQuery(event.target.value)}
          />
        </div>
      )}
      <div className="agent-picker-list" role="listbox" aria-label="CLI agents">
        {(listAll ? (state?.agents ?? []) : installedAgents)
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
                <small>{agent.installed ? agent.commands[0] : "Not installed"}</small>
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
      {detecting && !installedAgents.length && <p className="empty-small">Looking for agents…</p>}
      {!detecting && !installedAgents.length && (
        <p className="empty-small">
          No agent CLI found. Install one, then come back to Kairo; the list updates on its own.
        </p>
      )}
      {!!installedAgents.length && (
        <button className="link-button" onClick={() => setShowAllAgents((value) => !value)}>
          {showAllAgents ? "Show installed agents only" : "Add another agent…"}
        </button>
      )}
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
      <aside
        className="sidebar settings-nav"
        aria-label="Settings sections"
        hidden={!sidebarOpen || !settings}
      >
        <Button
          variant="ghost"
          className="settings-back h-9 justify-start text-muted-foreground"
          onClick={() => setSettings(false)}
        >
          ← Back to app
        </Button>
        <div className="section-label sidebar-section-title">Settings</div>
        {settingsTabs.map(([id, label]) => (
          <Button
            key={id}
            variant="ghost"
            className={`settings-tab h-9 justify-start font-normal ${settingsTab === id ? "selected bg-accent font-medium" : "text-muted-foreground"}`}
            aria-current={settingsTab === id ? "page" : undefined}
            onClick={() => setSettingsTab(id)}
          >
            {label}
          </Button>
        ))}
      </aside>
      <aside className="sidebar" aria-label="Workspaces" hidden={!sidebarOpen || settings}>
        <div className="brand">
          <KairoLogo className="brand-mark" />
          <span>Kairo</span>
          <button
            className="select-toggle"
            aria-pressed={selecting}
            disabled={pending}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
          >
            {selecting ? "Done" : "Select"}
          </button>
        </div>
        {state?.workspaces.some((w) => w.pinned && !w.archivedAt && !w.removedAt) && (
          <section className="pinned-sessions" aria-label="Pinned workspaces">
            <div className="section-label sidebar-section-title">Pinned</div>
            {state.workspaces
              .filter((w) => w.pinned && !w.archivedAt && !w.removedAt)
              .map(renderWorkspace)}
          </section>
        )}
        <div className="section-label sidebar-section-title">
          <span>Projects</span>
          <button
            className="icon-button open-project-button"
            aria-label="Open project"
            title="Open project folder"
            disabled={pending}
            onClick={() => void action(() => window.kairo.openWorkspace())}
          >
            <Icon name="folder" />
          </button>
        </div>
        <div className="project-session-list">
          {groups.map((group) => (
            <section className="project-session-group" key={group.path}>
              <div
                className="project-heading-row"
                {...menuHandlers(`${name(group.path)} project actions`, projectActions(group.path))}
              >
                {selecting && (
                  <input
                    type="checkbox"
                    className="select-box"
                    aria-label={`Select project ${name(group.path)}`}
                    checked={pickedProjects.has(group.path)}
                    onChange={() => setPickedProjects((set) => toggle(set, group.path))}
                  />
                )}
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
                  className="icon-button project-add"
                  aria-label={`New workspace in ${name(group.path)}`}
                  title="New workspace"
                  disabled={pending}
                  onClick={() => setWorkspaceDialog(group.path)}
                >
                  <Icon name="plus" />
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
                        setSettings(false);
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
        <section className="chat-section" aria-label="This computer">
          <div className="section-label sidebar-section-title">
            <span>This computer</span>
            <button
              className="icon-button"
              aria-label="New chat"
              title="New chat"
              disabled={pending}
              onClick={newChat}
            >
              <Icon name="plus" />
            </button>
          </div>
          {chats.map(renderWorkspace)}
          {!chats.length && <p className="empty-session-list">No chats yet</p>}
        </section>
        {selecting && (
          <div className="bulk-bar" role="toolbar" aria-label="Selection actions">
            <span>{pickedCount ? `${pickedCount} selected` : "Select items"}</span>
            <button disabled={pending || !pickedCount} onClick={() => bulk("archive")}>
              Archive
            </button>
            <button
              className="danger-outline-button"
              disabled={pending || !pickedCount}
              onClick={() => bulk("delete")}
            >
              Delete
            </button>
          </div>
        )}
        <button className="settings-link" onClick={() => setSettings(true)}>
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
              <button onClick={() => setSettings(false)}>Back to workspace</button>
            </>
          ) : (
            <>
              <strong className="workspace-heading">
                {operationId ? operation?.name : (workspace?.name ?? "Kairo")}
              </strong>
              {!operationId && runningAgents > 1 && (
                <span
                  className="shared-chip"
                  role="status"
                  title="These agents edit the same files. Use a separate workspace to keep their changes apart."
                >
                  {runningAgents} agents share these files
                </span>
              )}
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
                    {terminal.state === "running" &&
                      (terminal.activity === "working" || terminal.activity === "waiting") && (
                        <span
                          className={`tab-status ${activityClass[terminal.activity]}`}
                          title={activityLabel[terminal.activity]}
                          aria-hidden="true"
                        />
                      )}
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
          <h2>{settingsTabs.find(([id]) => id === settingsTab)?.[1]}</h2>
          {settingsTab === "general" && (
            <>
              <div className="settings-field">
                <span id="theme-label">Appearance</span>
                <Select
                  value={themeChoice}
                  onValueChange={(value) => setThemeChoice(value as ThemeChoice)}
                >
                  <SelectTrigger aria-labelledby="theme-label" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="empty-small">
                Agent conversations run inside the selected CLI. Models, authentication and
                approvals are managed by that agent.
              </p>
            </>
          )}
          {settingsTab === "chats" && (
            <>
              {!archivedChats.length && <p className="empty-small">No archived chats</p>}
              {archivedChats.length > 0 && (
                <div className="bulk-row">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void action(async () => {
                        let last: DesktopBootstrap | undefined;
                        for (const item of archivedChats)
                          last = await window.kairo.restoreWorkspace(item.id);
                        return last;
                      })
                    }
                  >
                    Recover all
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      setConfirm({
                        title: "Delete all archived chats?",
                        description: `Permanently delete ${archivedChats.length} archived ${archivedChats.length === 1 ? "chat" : "chats"} and their scratch folders. This cannot be undone.`,
                        action: async () => {
                          let last: DesktopBootstrap | undefined;
                          for (const item of archivedChats)
                            last = await window.kairo.deleteWorkspace(item.id);
                          if (last) apply(last);
                        },
                      })
                    }
                  >
                    Delete all
                  </Button>
                </div>
              )}
              {archivedChats.map((item) => (
                <article className="workspace-catalog-row" key={item.id}>
                  <div>
                    <strong>{item.name ?? name(item.directory)}</strong>
                    <small>archived</small>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => void action(() => window.kairo.restoreWorkspace(item.id))}
                  >
                    Restore
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => deleteWorkspace(item)}
                  >
                    Delete
                  </Button>
                </article>
              ))}
            </>
          )}
          {settingsTab === "workspaces" && (
            <>
              {state?.workspaces
                .filter((item) => !item.removedAt && !(isChat(item) && item.archivedAt))
                .map((item) => (
                  <article className="workspace-catalog-row" key={item.id}>
                    <div>
                      <strong>{item.name ?? item.branch ?? name(item.directory)}</strong>
                      <small>{item.archivedAt ? `${item.kind} · archived` : item.kind}</small>
                      <code>{item.directory}</code>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setSettings(false);
                        void action(() =>
                          item.archivedAt
                            ? window.kairo
                                .restoreWorkspace(item.id)
                                .then(() => window.kairo.selectWorkspace(item.id))
                            : window.kairo.selectWorkspace(item.id),
                        );
                      }}
                    >
                      {item.archivedAt ? "Restore" : "Open"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => deleteWorkspace(item)}
                    >
                      Delete
                    </Button>
                  </article>
                ))}
              {!state?.workspaces.some((item) => !item.removedAt) && (
                <p className="empty-small">No workspaces yet</p>
              )}
            </>
          )}
          {settingsTab === "tabs" && (
            <>
              {!archived.length && <p className="empty-small">No closed agent tabs</p>}

              {archived.map((session) => (
                <article className="workspace-catalog-row" key={session.id}>
                  <div>
                    <strong>{session.title}</strong>
                    <code>
                      {state?.workspaces.find((item) => item.id === session.workspaceId)?.directory}
                    </code>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      pending ||
                      !!state?.workspaces.find((item) => item.id === session.workspaceId)?.removedAt
                    }
                    onClick={() => void action(() => window.kairo.restoreSession(session.id))}
                  >
                    Restore
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      setConfirm({
                        title: "Delete closed tab?",
                        description: `Delete “${session.title}” from Kairo. Its workspace and the agent’s own history are kept.`,
                        action: () => window.kairo.deleteSession(session.id).then(apply),
                      })
                    }
                  >
                    Delete
                  </Button>
                </article>
              ))}
            </>
          )}
          {settingsTab === "shortcuts" && (
            <dl className="shortcut-list">
              {shortcuts.map(([keys, description]) => (
                <React.Fragment key={keys}>
                  <dt>{keys}</dt>
                  <dd>{description}</dd>
                </React.Fragment>
              ))}
            </dl>
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
          {!activeTerminalId && !operationId && !kairoView && (workspace || groups.length > 0) && (
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
                        : beginSession()
                  }
                >
                  {workspace?.archivedAt
                    ? "Restore workspace"
                    : current
                      ? "Open agent terminal"
                      : "New agent session"}
                </button>
              )}
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
                  onClick={() => {
                    setContextTab(tab);
                  }}
                >
                  {tab === "files" ? "Files" : "Review"}
                </button>
              ))}
            </div>
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
            {runningAgents > 0 && workspace && (
              <div className="shared-warning" role="note">
                <p>
                  {runningAgents === 1 ? "An agent is" : `${runningAgents} agents are`} already
                  running here. Agents in the same workspace edit the same files, and Kairo cannot
                  stop one from overwriting the other.
                </p>
                {workspace.repositoryPath !== state?.chatsRoot && (
                  <button
                    onClick={() => {
                      setNewOpen(false);
                      setWorkspaceDialog(workspace.repositoryPath);
                    }}
                  >
                    Use a separate workspace instead
                  </button>
                )}
              </div>
            )}
            {agentPicker()}
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
