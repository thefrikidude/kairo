import { UsageFooter } from "./usage-footer.js";
import { UserInputCard } from "./user-input-card.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import parseDiff from "parse-diff";
import type { DesktopBootstrap, LiveSession } from "../../shared/api.js";
import type { SessionRuntime } from "../../../../domain/agent-runtime.js";
import type { ModelSelection, Message, TaskEvent } from "../../../../domain/models.js";

type Mode = "build" | "plan";
type Theme = "light" | "dark";
type SettingsSection = "general" | "models" | "archived";
const SIDEBAR_DEFAULT_WIDTH = 224;
const SIDEBAR_MIN_WIDTH = 176;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSE_THRESHOLD = 156;
type ChangeSummary = {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  unavailable?: string;
};
type DiffRow = {
  kind: "add" | "remove" | "context" | "hunk" | "meta" | "fold";
  oldLine?: number;
  newLine?: number;
  count?: number;
  text: string;
};

async function summarizeChanges(sessionId: string): Promise<ChangeSummary[]> {
  const paths = await window.kairo.changedFiles(sessionId);
  return Promise.all(
    paths.map(async (path) => {
      const { diff, unavailable } = await window.kairo.diff(sessionId, path);
      const files = parseDiff(diff);
      let additions = files.reduce((total, file) => total + file.additions, 0);
      const deletions = files.reduce((total, file) => total + file.deletions, 0);
      if (!files.length && unavailable && diff.trim())
        additions = diff.split(/\r?\n/).filter(Boolean).length;
      return { path, additions, deletions, diff, unavailable };
    }),
  );
}

function parseDiffRows(diff: string): DiffRow[] {
  const files = parseDiff(diff);
  if (!files.length)
    return diff
      .split(/\r?\n/)
      .filter(Boolean)
      .map((text, index) => ({ kind: "add", newLine: index + 1, text }));
  return files.flatMap((file) => {
    const rows: DiffRow[] = [];
    let previousChunk: (typeof file.chunks)[number] | undefined;
    for (const chunk of file.chunks) {
      if (previousChunk) {
        const gap = Math.max(
          chunk.oldStart - previousChunk.oldStart - previousChunk.oldLines,
          chunk.newStart - previousChunk.newStart - previousChunk.newLines,
        );
        if (gap > 0) rows.push({ kind: "fold", count: gap, text: "" });
      }
      rows.push({ kind: "hunk", text: chunk.content });
      rows.push(
        ...chunk.changes.map((change): DiffRow => {
          if (change.content.startsWith("\\")) return { kind: "meta", text: change.content };
          if (change.type === "add")
            return { kind: "add", newLine: change.ln, text: change.content.slice(1) };
          if (change.type === "del")
            return { kind: "remove", oldLine: change.ln, text: change.content.slice(1) };
          return {
            kind: "context",
            oldLine: change.ln1,
            newLine: change.ln2,
            text: change.content.slice(1),
          };
        }),
      );
      previousChunk = chunk;
    }
    return rows;
  });
}

function DiffLine({ row }: { row: DiffRow }): React.JSX.Element {
  if (row.kind === "hunk") return <div className="diff-hunk">{row.text}</div>;
  if (row.kind === "fold")
    return <div className="diff-context-gap">{row.count} unmodified lines</div>;
  const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "−" : "";
  return (
    <div className={`diff-row diff-${row.kind}`}>
      <span className="diff-line-number">{row.oldLine ?? ""}</span>
      <span className="diff-line-number">{row.newLine ?? ""}</span>
      <span className="diff-marker">{marker}</span>
      <code>{row.text || " "}</code>
    </div>
  );
}

function DiffContents({ diff }: { diff: string }): React.JSX.Element {
  const rows = parseDiffRows(diff);
  const content: React.ReactNode[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== "context") {
      content.push(<DiffLine key={index} row={rows[index]} />);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].kind === "context") end += 1;
    const context = rows.slice(index, end);
    if (context.length > 8) {
      content.push(
        <details className="diff-context-fold" key={index}>
          <summary>{context.length} unmodified lines</summary>
          {context.map((row, offset) => (
            <DiffLine key={index + offset} row={row} />
          ))}
        </details>,
      );
    } else {
      content.push(...context.map((row, offset) => <DiffLine key={index + offset} row={row} />));
    }
    index = end;
  }
  return <div className="diff-rows">{content}</div>;
}

function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return (extension || name.slice(0, 2)).slice(0, 3).toUpperCase();
}

const codexCommands = [
  { name: "/plan", command: "plan" as const, description: "Switch Codex to Plan mode" },
  {
    name: "/default",
    command: "default" as const,
    description: "Switch Codex to its default mode",
  },
  { name: "/model", command: "model" as const, description: "Change the Codex model" },
  { name: "/compact", command: "compact" as const, description: "Compact this conversation" },
];

export function DesktopApp(): React.JSX.Element {
  const [state, setState] = useState<DesktopBootstrap>();
  const [, setClock] = useState(0);
  const activeSession = state?.sessions.find((item) => item.id === state.activeSessionId);
  const projectGroups = useMemo(() => {
    const sessions = state?.sessions ?? [];
    const groups = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const group = groups.get(session.workspace) ?? [];
      group.push(session);
      groups.set(session.workspace, group);
    }
    return [...groups].map(([workspace, groupedSessions]) => ({
      workspace,
      name: workspace.split("/").filter(Boolean).at(-1) ?? workspace,
      sessions: groupedSessions,
    }));
  }, [state?.sessions]);
  const activeModelSelection =
    activeSession?.runtime.kind === "builtin"
      ? (activeSession.runtime.selection ?? state?.config)
      : state?.config;
  const live = state?.activeSessionId ? state.liveSessions[state.activeSessionId] : undefined;
  const busy = Boolean(live && ["running", "waiting", "cancelling"].includes(live.state));
  const stream = busy ? (live?.stream ?? "") : "";
  const toolActivity = live?.events ?? [];
  const userInput = state?.userInputs.find((item) => item.sessionId === state.activeSessionId);
  const activity =
    live?.state === "waiting"
      ? userInput
        ? "Waiting for your answer"
        : "Waiting for approval"
      : live?.state === "cancelling"
        ? "Stopping…"
        : "Working";
  const elapsedSeconds = live
    ? Math.floor(((live.finishedAt ?? Date.now()) - live.startedAt) / 1000)
    : 0;
  const showWorkedDuration = Boolean(live && !busy);
  const approval = state?.approvals.find((item) => item.sessionId === state.activeSessionId);
  const externalAgent =
    activeSession?.runtime.kind === "external"
      ? state?.agents.find(
          (item) =>
            activeSession.runtime.kind === "external" && item.id === activeSession.runtime.agentId,
        )
      : undefined;
  const workspaceBusy = Boolean(
    state?.sessions.some(
      (session) =>
        session.workspace === activeSession?.workspace &&
        ["running", "waiting", "cancelling"].includes(state.liveSessions[session.id]?.state),
    ),
  );
  const [agentSetupBusy, setAgentSetupBusy] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionChoice, setNewSessionChoice] = useState("");
  const [newSessionWorkspace, setNewSessionWorkspace] = useState("");
  const [workspacePickerBusy, setWorkspacePickerBusy] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const prompt = state?.activeSessionId ? (drafts[state.activeSessionId] ?? "") : "";
  const setPrompt = (text: string) => {
    if (state?.activeSessionId)
      setDrafts((current) => ({ ...current, [state.activeSessionId!]: text }));
  };
  const [mode, setMode] = useState<Mode>("build");
  const isCodexSession =
    activeSession?.runtime.kind === "external" && activeSession.runtime.agentId === "codex";
  const [codexModes, setCodexModes] = useState<Record<string, "default" | "plan">>(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem("kairo.codexModes") ?? "{}");
      return saved && typeof saved === "object"
        ? (saved as Record<string, "default" | "plan">)
        : {};
    } catch {
      return {};
    }
  });
  const codexMode =
    activeSession?.runtime.kind === "external"
      ? (activeSession.runtime.codexMode ?? codexModes[activeSession.id] ?? "default")
      : "default";
  const [commandIndex, setCommandIndex] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("kairo.sidebarWidth"));
      return Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH
        ? Math.min(saved, SIDEBAR_MAX_WIDTH)
        : SIDEBAR_DEFAULT_WIDTH;
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const [sidebarResizeActive, setSidebarResizeActive] = useState(false);
  const [changes, setChanges] = useState<ChangeSummary[]>([]);
  const [viewingChanges, setViewingChanges] = useState(false);
  const [pinnedSessions, setPinnedSessions] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(
        window.localStorage.getItem("kairo.pinnedSessions") ?? "[]",
      );
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [deleteSessionId, setDeleteSessionId] = useState<string>();
  const [deleteAllArchivedOpen, setDeleteAllArchivedOpen] = useState(false);
  const [projectMenuWorkspace, setProjectMenuWorkspace] = useState<string>();
  const [deleteProjectWorkspace, setDeleteProjectWorkspace] = useState<string>();
  const [projectDeleteBusy, setProjectDeleteBusy] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("kairo.collapsedProjects") ?? "{}");
    } catch {
      return {};
    }
  });
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return window.localStorage.getItem("kairo.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [selection, setSelection] = useState<ModelSelection>({
    provider: "gemini",
    model: "gemini-2.5-flash",
  });
  const [apiKey, setApiKey] = useState("");
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelNotice, setModelNotice] = useState("");
  const selectedProvider = state?.providers.find((provider) => provider.id === selection.provider);
  const needsApiKey = !selectedProvider?.hasCredential || editingApiKey;
  const [archiveDeleteBusy, setArchiveDeleteBusy] = useState(false);
  const [archiveDeleteError, setArchiveDeleteError] = useState("");
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuButtonRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followTranscript = useRef(true);
  const activeSessionRef = useRef<string | undefined>(undefined);
  const navigationRevision = useRef(0);

  useEffect(() => {
    if (settingsOpen && settingsSection === "models") return;
    if (state?.config) setSelection(state.config);
    setApiKey("");
    setEditingApiKey(false);
    setModelNotice("");
  }, [state?.config.provider, state?.config.model, settingsOpen, settingsSection]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setClock((clock) => clock + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = Math.min(240, Math.max(112, window.innerHeight * 0.3));
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [prompt]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("kairo.theme", theme);
    } catch {
      // The selected theme still applies for this window if storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kairo.collapsedProjects", JSON.stringify(collapsedProjects));
    } catch {
      // Project expansion still works for this window if storage is unavailable.
    }
  }, [collapsedProjects]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kairo.pinnedSessions", JSON.stringify(pinnedSessions));
    } catch {
      // Pin state remains available for this window if storage is unavailable.
    }
  }, [pinnedSessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kairo.sidebarWidth", String(sidebarWidth));
    } catch {
      // Resizing still works for this window if storage is unavailable.
    }
  }, [sidebarWidth]);

  const resizeSidebar = (requestedWidth: number) => {
    if (requestedWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
      setSidebarOpen(false);
      setSidebarResizeActive(false);
      return;
    }
    setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(requestedWidth, SIDEBAR_MAX_WIDTH)));
  };

  const applyState = useCallback((next: DesktopBootstrap) => {
    activeSessionRef.current = next.activeSessionId;
    setState(next);
    setError("");
  }, []);

  const reload = useCallback(
    async (sessionId?: string) => {
      const revision = navigationRevision.current;
      const next = await window.kairo.bootstrap();
      if (revision !== navigationRevision.current) return;
      if (
        sessionId &&
        (next.activeSessionId !== sessionId || activeSessionRef.current !== sessionId)
      )
        return;
      applyState(next);
      if (next.activeSessionId) {
        const changed = await summarizeChanges(next.activeSessionId);
        if (activeSessionRef.current !== next.activeSessionId) return;
        setChanges(changed);
      } else {
        setChanges([]);
      }
    },
    [applyState],
  );

  const focusSession = useCallback(
    async (next: DesktopBootstrap | undefined) => {
      if (!next) return;
      applyState(next);
      followTranscript.current = true;
      setViewingChanges(false);
      if (next.activeSessionId) {
        const changed = await summarizeChanges(next.activeSessionId);
        if (activeSessionRef.current !== next.activeSessionId) return;
        setChanges(changed);
      } else {
        setChanges([]);
      }
    },
    [applyState],
  );

  const openWorkspace = async () => {
    const revision = ++navigationRevision.current;
    try {
      const next = await window.kairo.openWorkspace();
      if (revision === navigationRevision.current) await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openSession = async (sessionId: string) => {
    const revision = ++navigationRevision.current;
    try {
      const next = await window.kairo.openSession(sessionId);
      if (revision === navigationRevision.current) await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const newSession = async (runtime: SessionRuntime, workspace: string) => {
    const revision = ++navigationRevision.current;
    try {
      const next = await window.kairo.newSession(runtime, workspace);
      if (revision === navigationRevision.current) {
        setNewSessionOpen(false);
        setNewSessionChoice("");
        setNewSessionWorkspace("");
        await focusSession(next);
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const createSelectedSession = () => {
    if (!newSessionChoice || !newSessionWorkspace || !state) return;
    try {
      const [kind, first, ...rest] = JSON.parse(newSessionChoice) as string[];
      if (kind === "agent" && first) {
        void newSession({ kind: "external", agentId: first }, newSessionWorkspace);
      } else if (kind === "model" && first && rest.length) {
        void newSession(
          {
            kind: "builtin",
            selection: { provider: first as ModelSelection["provider"], model: rest.join(":") },
          },
          newSessionWorkspace,
        );
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const pickSessionWorkspace = async () => {
    setWorkspacePickerBusy(true);
    try {
      const workspace = await window.kairo.pickWorkspace();
      if (workspace) setNewSessionWorkspace(workspace);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setWorkspacePickerBusy(false);
    }
  };

  useEffect(() => {
    void reload().catch((cause) => setError((cause as Error).message));
    const stopChunk = window.kairo.onChunk(({ sessionId, chunk }) => {
      if (chunk === "\n[Plan saved]\n" || /^\n\[Tool\] [^\n]+\n$/.test(chunk)) return;
      setState((current) => {
        if (!current) return current;
        const previous = current.liveSessions[sessionId];
        if (!previous) return current;
        return {
          ...current,
          liveSessions: {
            ...current.liveSessions,
            [sessionId]: { ...previous, stream: previous.stream + chunk },
          },
        };
      });
    });
    const stopTaskEvent = window.kairo.onTaskEvent((event) => {
      if (event.kind !== "tool_started" && event.kind !== "tool_finished") return;
      setState((current) => {
        const previous = current?.liveSessions[event.sessionId];
        if (!current || !previous) return current;
        const events = [...previous.events];
        const index = events.findIndex((item) => item.operationId === event.operationId);
        if (index < 0) events.push(event);
        else events[index] = event;
        return {
          ...current,
          liveSessions: { ...current.liveSessions, [event.sessionId]: { ...previous, events } },
        };
      });
    });
    const stopState = window.kairo.onTaskState((event) => {
      setState((current) => {
        if (!current) return current;
        const previous = current.liveSessions[event.sessionId];
        const terminal = ["complete", "cancelled", "error"].includes(event.state);
        const next: LiveSession = {
          ...(previous ?? { startedAt: Date.now(), stream: "", events: [] }),
          state: event.state as LiveSession["state"],
          error: event.error,
          finishedAt: terminal ? Date.now() : undefined,
        };
        if (
          event.state === "running" &&
          previous &&
          ["complete", "cancelled", "error"].includes(previous.state)
        ) {
          next.startedAt = Date.now();
          next.stream = "";
          next.events = [];
        }
        return {
          ...current,
          liveSessions: { ...current.liveSessions, [event.sessionId]: next },
          userInputs: terminal
            ? current.userInputs.filter((item) => item.sessionId !== event.sessionId)
            : current.userInputs,
          approvals: terminal
            ? current.approvals.filter((item) => item.sessionId !== event.sessionId)
            : current.approvals,
        };
      });
      if (["complete", "cancelled", "error"].includes(event.state)) {
        void reload(event.sessionId).catch((cause) => setError((cause as Error).message));
      }
    });
    const stopApproval = window.kairo.onApproval((request) => {
      setState((current) => {
        if (!current) return current;
        const previous = current.liveSessions[request.sessionId];
        return {
          ...current,
          approvals: [...current.approvals.filter((item) => item.id !== request.id), request],
          liveSessions: previous
            ? { ...current.liveSessions, [request.sessionId]: { ...previous, state: "waiting" } }
            : current.liveSessions,
        };
      });
    });
    const stopUserInput = window.kairo.onUserInput((request) => {
      setState((current) => {
        if (!current) return current;
        const live = current.liveSessions[request.sessionId];
        return {
          ...current,
          userInputs: [...current.userInputs.filter((item) => item.id !== request.id), request],
          liveSessions: live
            ? { ...current.liveSessions, [request.sessionId]: { ...live, state: "waiting" } }
            : current.liveSessions,
        };
      });
    });
    const stopUserInputResolved = window.kairo.onUserInputResolved(({ id }) => {
      setState((current) =>
        current
          ? { ...current, userInputs: current.userInputs.filter((item) => item.id !== id) }
          : current,
      );
    });
    const stopRuntimeError = window.kairo.onRuntimeError(({ error: message }) => {
      setError(message);
      setState((current) =>
        current
          ? {
              ...current,
              approvals: [],
              userInputs: [],
              liveSessions: Object.fromEntries(
                Object.entries(current.liveSessions).map(([id, session]) => [
                  id,
                  ["running", "waiting", "cancelling"].includes(session.state)
                    ? { ...session, state: "error", error: message, finishedAt: Date.now() }
                    : session,
                ]),
              ),
            }
          : current,
      );
    });
    return () => {
      stopUserInput();
      stopUserInputResolved();
      stopRuntimeError();
      stopChunk();
      stopTaskEvent();
      stopState();
      stopApproval();
    };
  }, [reload]);

  const refreshAgents = useCallback(async () => {
    const agents = await window.kairo.refreshAgents();
    setState((current) => (current ? { ...current, agents } : current));
    return agents;
  }, []);

  const stateReady = Boolean(state);
  useEffect(() => {
    if (!stateReady) return;
    void refreshAgents().catch((cause) => setError((cause as Error).message));
  }, [refreshAgents, stateReady]);

  useEffect(() => {
    if (!loginPending) return;
    let disposed = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void refreshAgents()
        .then((agents) => {
          if (!disposed && agents.some((agent) => agent.id === "codex" && agent.authenticated))
            setLoginPending(false);
        })
        .catch((cause) => {
          if (!disposed) {
            setError((cause as Error).message);
            setLoginPending(false);
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 3000);
    const timeout = window.setTimeout(() => setLoginPending(false), 5 * 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [loginPending, refreshAgents]);

  const chooseRuntime = async (runtime: SessionRuntime) => {
    if (!activeSession) return;
    setAgentSetupBusy(true);
    const sessionId = activeSession.id;
    const revision = navigationRevision.current;
    try {
      const next = await window.kairo.setRuntime(sessionId, runtime);
      if (revision === navigationRevision.current && activeSessionRef.current === sessionId)
        applyState(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setAgentSetupBusy(false);
    }
  };

  const loginAgent = async () => {
    if (!externalAgent) return;
    setAgentSetupBusy(true);
    try {
      await window.kairo.loginAgent(externalAgent.id);
      setLoginPending(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setAgentSetupBusy(false);
    }
  };

  useEffect(() => {
    if (!followTranscript.current) return;
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "instant",
    });
  }, [state?.messages, stream, userInput?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (archiveDeleteBusy) return;
      if (deleteSessionId) setDeleteSessionId(undefined);
      else if (deleteAllArchivedOpen) setDeleteAllArchivedOpen(false);
      else if (deleteProjectWorkspace) setDeleteProjectWorkspace(undefined);
      else if (newSessionOpen) setNewSessionOpen(false);
      else if (projectMenuWorkspace) setProjectMenuWorkspace(undefined);
      else if (settingsOpen) setSettingsOpen(false);
      else if (busy && state?.activeSessionId) {
        void window.kairo.cancel(state.activeSessionId).catch((cause) => setError(String(cause)));
      } else setReviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    settingsOpen,
    deleteSessionId,
    deleteAllArchivedOpen,
    archiveDeleteBusy,
    deleteProjectWorkspace,
    newSessionOpen,
    projectMenuWorkspace,
    busy,
    state?.activeSessionId,
  ]);

  useEffect(() => {
    if (!projectMenuWorkspace) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !projectMenuRef.current?.contains(target) &&
        !projectMenuButtonRef.current?.contains(target)
      )
        setProjectMenuWorkspace(undefined);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [projectMenuWorkspace]);

  const messages = useMemo(
    () =>
      state?.messages.filter(
        (item) => (item.role === "user" || item.role === "model") && !item.toolCallId,
      ) ?? [],
    [state?.messages],
  );

  const refreshChanges = async () => {
    if (!state?.activeSessionId) return;
    try {
      const changed = await summarizeChanges(state.activeSessionId);
      setChanges(changed);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openInCursor = async (path: string) => {
    if (!state?.activeSessionId || !path) return;
    try {
      await window.kairo.openInCursor(state.activeSessionId, path);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const commandQuery = isCodexSession ? prompt.trimStart() : "";
  const commandSuggestions = (() => {
    if (!commandQuery.startsWith("/") || commandQuery.includes("\n")) return [];
    const [typedName, ...argumentParts] = commandQuery.split(/\s+/);
    if (typedName === "/model" && (argumentParts.length || commandQuery === "/model")) {
      const modelPrefix = argumentParts.join(" ").toLowerCase();
      return (externalAgent?.models ?? [])
        .filter(
          (item) =>
            item.id.toLowerCase().includes(modelPrefix) ||
            item.label.toLowerCase().includes(modelPrefix),
        )
        .slice(0, 8)
        .map((item) => ({
          key: item.id,
          value: `/model ${item.id}`,
          title: item.label,
          description: item.id,
        }));
    }
    return codexCommands
      .filter((item) => item.name.startsWith(typedName))
      .map((item) => ({
        key: item.name,
        value: item.name,
        title: item.name,
        description: item.description,
      }));
  })();

  const setCodexMode = async (nextMode: "default" | "plan") => {
    if (!state?.activeSessionId) return;
    try {
      await window.kairo.codexCommand(state.activeSessionId, nextMode);
      setState((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((session) =>
                session.id === state.activeSessionId && session.runtime.kind === "external"
                  ? { ...session, runtime: { ...session.runtime, codexMode: nextMode } }
                  : session,
              ),
            }
          : current,
      );
      setCodexModes((current) => {
        const next = { ...current, [state.activeSessionId!]: nextMode };
        try {
          window.localStorage.setItem("kairo.codexModes", JSON.stringify(next));
        } catch {
          // The native Codex setting is already applied; local mode memory is optional.
        }
        return next;
      });
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const sendTask = async () => {
    if (!state?.activeSessionId || !prompt.trim() || busy || agentSetupBusy) return;
    const text = prompt.trim();
    if (isCodexSession && text.startsWith("/")) {
      const [typedName, ...argumentParts] = text.split(/\s+/);
      const definition = codexCommands.find((item) => item.name === typedName);
      if (!definition) {
        setError(`Unsupported Codex command: ${typedName}. Type / to see available commands.`);
        return;
      }
      const argument = argumentParts.join(" ").trim();
      if (definition.command === "model" && !argument) {
        setError("Choose a model from the command suggestions.");
        return;
      }
      setPrompt("");
      setError("");
      try {
        const result = await window.kairo.codexCommand(
          state.activeSessionId,
          definition.command,
          argument || undefined,
        );
        setState((current) =>
          current && current.activeSessionId === state.activeSessionId
            ? {
                ...current,
                sessions:
                  definition.command === "plan" || definition.command === "default"
                    ? current.sessions.map((session) =>
                        session.id === state.activeSessionId && session.runtime.kind === "external"
                          ? {
                              ...session,
                              runtime: {
                                ...session.runtime,
                                codexMode: definition.command as "default" | "plan",
                              },
                            }
                          : session,
                      )
                    : current.sessions,
                messages: [
                  ...current.messages,
                  { role: "model", content: result, createdAt: Date.now() },
                ],
              }
            : current,
        );
        if (definition.command === "plan" || definition.command === "default") {
          const nextMode = definition.command;
          setCodexModes((current) => {
            const next = { ...current, [state.activeSessionId!]: nextMode };
            try {
              window.localStorage.setItem("kairo.codexModes", JSON.stringify(next));
            } catch {
              // The native Codex setting is already applied; local mode memory is optional.
            }
            return next;
          });
        }
      } catch (cause) {
        setPrompt(text);
        setError((cause as Error).message);
      }
      return;
    }
    setPrompt("");
    followTranscript.current = true;
    setState((current) =>
      current
        ? {
            ...current,
            messages: [...current.messages, { role: "user", content: text, createdAt: Date.now() }],
            liveSessions: {
              ...current.liveSessions,
              [current.activeSessionId!]: {
                state: "running",
                startedAt: Date.now(),
                stream: "",
                events: [],
              },
            },
          }
        : current,
    );
    setError("");
    try {
      await window.kairo.send(
        state.activeSessionId,
        text,
        mode,
        isCodexSession ? codexMode : undefined,
      );
    } catch (cause) {
      setState((current) => {
        if (!current || current.activeSessionId !== state.activeSessionId) return current;
        const previous = current.liveSessions[state.activeSessionId!];
        return {
          ...current,
          messages: current.messages.filter(
            (item, index) =>
              index !== current.messages.length - 1 ||
              item.role !== "user" ||
              item.content !== text,
          ),
          liveSessions: {
            ...current.liveSessions,
            [state.activeSessionId!]: { ...previous, state: "error", finishedAt: Date.now() },
          },
        };
      });
      setError((cause as Error).message);
    }
  };

  const choosePrompt = (value: string) => {
    setPrompt(value);
    composerRef.current?.focus();
  };

  const chooseModel = async () => {
    if (modelSaving || (needsApiKey && !apiKey.trim())) return;
    setModelSaving(true);
    setModelNotice("");
    setError("");
    try {
      const next = await window.kairo.saveModel(selection, apiKey);
      setApiKey("");
      setEditingApiKey(false);
      applyState(next);
      setModelNotice("Model settings saved.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setModelSaving(false);
    }
  };

  const chooseComposerModel = async (choice: ModelSelection) => {
    if (busy || modelSaving) return;
    const provider = state?.providers.find((item) => item.id === choice.provider);
    if (!provider) return;
    if (!provider.hasCredential) {
      setSelection(choice);
      setApiKey("");
      setEditingApiKey(false);
      setSettingsSection("models");
      setSettingsOpen(true);
      return;
    }
    setModelSaving(true);
    setError("");
    try {
      const next = await window.kairo.saveModel(choice);
      applyState(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setModelSaving(false);
    }
  };

  const archiveSession = async (sessionId: string) => {
    try {
      const next = await window.kairo.archiveSession(sessionId);
      await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const deleteProject = async (workspace: string) => {
    setProjectDeleteBusy(true);
    try {
      const next = await window.kairo.deleteProject(workspace);
      setDeleteProjectWorkspace(undefined);
      setProjectMenuWorkspace(undefined);
      setCollapsedProjects((current) => {
        const updated = { ...current };
        delete updated[workspace];
        return updated;
      });
      await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setProjectDeleteBusy(false);
    }
  };

  const archiveProject = async (workspace: string) => {
    try {
      const next = await window.kairo.archiveProject(workspace);
      setProjectMenuWorkspace(undefined);
      await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const restoreSession = async (sessionId: string) => {
    try {
      const next = await window.kairo.restoreSession(sessionId);
      applyState(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const togglePinnedSession = (sessionId: string) => {
    setPinnedSessions((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId],
    );
  };

  const deleteArchivedChats = async () => {
    if (archiveDeleteBusy) return;
    setArchiveDeleteBusy(true);
    setArchiveDeleteError("");
    try {
      const next = deleteSessionId
        ? await window.kairo.deleteSession(deleteSessionId)
        : await window.kairo.deleteArchivedSessions();
      setDeleteSessionId(undefined);
      setDeleteAllArchivedOpen(false);
      applyState(next);
    } catch (cause) {
      setArchiveDeleteError((cause as Error).message);
    } finally {
      setArchiveDeleteBusy(false);
    }
  };

  const pickApproval = async (decision: "approve" | "task_file" | "deny") => {
    if (!approval) return;
    await window.kairo.resolveApproval(approval.id, decision);
    setState((current) =>
      current
        ? { ...current, approvals: current.approvals.filter((item) => item.id !== approval.id) }
        : current,
    );
  };

  if (!state)
    return (
      <main className="loading">
        {error ? (
          <div>
            <p>{error}</p>
            <button
              className="primary"
              onClick={() => void reload().catch((cause) => setError((cause as Error).message))}
            >
              Retry
            </button>
          </div>
        ) : (
          "Starting Kairo…"
        )}
      </main>
    );

  const settingsPage = (
    <div className="settings-shell" data-theme={theme}>
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={() => setSettingsOpen(false)}>
          <span aria-hidden="true">←</span> Back to Kairo
        </button>
        <div className="settings-title">Settings</div>
        {(["general", "models", "archived"] as const).map((section) => (
          <button
            key={section}
            className={`settings-nav ${settingsSection === section ? "selected" : ""}`}
            aria-current={settingsSection === section ? "page" : undefined}
            onClick={() => setSettingsSection(section)}
          >
            {section === "general" ? "General" : section === "models" ? "Models" : "Archived chats"}
            {section === "archived" && <small>{state.archivedSessions.length}</small>}
          </button>
        ))}
      </aside>
      <main className="settings-content">
        <header>
          <h1>
            {settingsSection === "general"
              ? "General"
              : settingsSection === "models"
                ? "Models"
                : "Archived chats"}
          </h1>
        </header>
        {settingsSection === "general" && (
          <section className="settings-card">
            <div className="theme-setting">
              <span>Appearance</span>
              <div className="theme-options" role="group" aria-label="Appearance">
                {(["light", "dark"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={theme === option ? "selected" : ""}
                    aria-pressed={theme === option}
                    onClick={() => setTheme(option)}
                  >
                    {option === "light" ? "Light" : "Dark"}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}
        {settingsSection === "models" && (
          <section className="settings-card model-settings">
            <label>
              Provider
              <select
                disabled={modelSaving}
                value={selection.provider}
                onChange={(event) => {
                  const provider = state.providers.find((item) => item.id === event.target.value);
                  setApiKey("");
                  setEditingApiKey(false);
                  setModelNotice("");
                  setError("");
                  if (provider)
                    setSelection({
                      provider: provider.id,
                      model:
                        provider.models.find((item) => item.recommended)?.id ??
                        provider.models[0]?.id ??
                        "",
                    });
                }}
              >
                {state.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select
                disabled={modelSaving}
                value={selection.model}
                onChange={(event) => {
                  setSelection((current) => ({ ...current, model: event.target.value }));
                  setModelNotice("");
                }}
              >
                {state.providers
                  .find((item) => item.id === selection.provider)
                  ?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
              </select>
            </label>
            <div className="credential-setting">
              {needsApiKey ? (
                <>
                  <label>
                    {editingApiKey ? "New API key" : "API key"}
                    <input
                      autoFocus={editingApiKey || !selectedProvider?.hasCredential}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={modelSaving}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={`Enter your ${selectedProvider?.name ?? "provider"} API key`}
                      aria-describedby="credential-help"
                    />
                  </label>
                  <div className="credential-help-row">
                    <p id="credential-help">New keys are validated and stored in macOS Keychain.</p>
                    {editingApiKey && (
                      <button
                        className="text-button"
                        disabled={modelSaving}
                        onClick={() => {
                          setEditingApiKey(false);
                          setApiKey("");
                          setError("");
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="credential-status">
                  <div>
                    <span className="credential-status-title">
                      <Icon name="check" /> API key configured
                    </span>
                    <p>Ready to use with {selectedProvider?.name}.</p>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={modelSaving}
                    onClick={() => {
                      setEditingApiKey(true);
                      setModelNotice("");
                    }}
                  >
                    Update key
                  </button>
                </div>
              )}
            </div>
            <div className="model-settings-footer">
              <span className="settings-notice" role="status">
                {modelNotice}
              </span>
              <button
                className="primary"
                disabled={modelSaving || (needsApiKey && !apiKey.trim())}
                onClick={() => void chooseModel()}
              >
                {modelSaving ? "Saving…" : editingApiKey ? "Update key & save" : "Save model"}
              </button>
            </div>
          </section>
        )}
        {settingsSection === "archived" && (
          <section className="settings-card archived-list">
            <div className="archived-list-header">
              <span>
                {state.archivedSessions.length} archived{" "}
                {state.archivedSessions.length === 1 ? "chat" : "chats"}
              </span>
              <button
                className="danger-outline-button"
                disabled={!state.archivedSessions.length}
                onClick={() => {
                  setArchiveDeleteError("");
                  setDeleteAllArchivedOpen(true);
                }}
              >
                <Icon name="trash" /> Delete all
              </button>
            </div>
            {state.archivedSessions.length ? (
              state.archivedSessions.map((session) => (
                <div className="archived-row" key={session.id}>
                  <div className="archived-chat-details">
                    <strong title={session.title}>{session.title}</strong>
                    <small title={session.workspace}>
                      <Icon name="folder" />{" "}
                      {session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace}
                    </small>
                  </div>
                  <div className="archived-actions">
                    <button onClick={() => void restoreSession(session.id)}>Restore</button>
                    <button
                      className="archive-delete-button"
                      aria-label={`Delete ${session.title}`}
                      title="Delete chat"
                      onClick={() => {
                        setArchiveDeleteError("");
                        setDeleteSessionId(session.id);
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty-settings">Archived chats will appear here.</p>
            )}
          </section>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </main>
      {(deleteSessionId || deleteAllArchivedOpen) && (
        <DeleteChatDialog
          title={deleteSessionId ? "Delete this chat?" : "Delete all archived chats?"}
          description={
            deleteSessionId
              ? `“${state.archivedSessions.find((session) => session.id === deleteSessionId)?.title ?? "This chat"}” and its task history will be permanently deleted.`
              : `All ${state.archivedSessions.length} archived chats and their task history will be permanently deleted. Active chats will be kept.`
          }
          busy={archiveDeleteBusy}
          error={archiveDeleteError}
          onCancel={() => {
            setDeleteSessionId(undefined);
            setDeleteAllArchivedOpen(false);
          }}
          onConfirm={() => void deleteArchivedChats()}
          confirmLabel={deleteSessionId ? "Delete chat" : "Delete all chats"}
        />
      )}
    </div>
  );

  if (settingsOpen) return settingsPage;

  return (
    <div
      className={`app-shell ${reviewOpen ? "review-open" : ""} ${sidebarOpen ? "" : "sidebar-closed"} ${sidebarResizeActive ? "sidebar-resizing" : ""}`}
      data-theme={theme}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside className="sidebar" aria-label="Chats" hidden={!sidebarOpen}>
        <div className="brand">
          <KairoLogo className="brand-mark" />
          <span>Kairo</span>
        </div>
        <button
          className="new-chat"
          onClick={() => {
            const openCode = state?.agents.find(
              (agent) =>
                agent.id === "opencode" && agent.installed && agent.authenticated && !agent.error,
            );
            setNewSessionChoice(openCode ? JSON.stringify(["agent", "opencode"]) : "");
            setNewSessionWorkspace("");
            setNewSessionOpen(true);
          }}
        >
          <Icon name="plus" /> New agent session
        </button>
        <button className="open-project-button" onClick={() => void openWorkspace()}>
          <Icon name="folder" /> Open project
        </button>
        <div className="section-label sidebar-section-title">Projects</div>
        <div className="project-session-list">
          {projectGroups.length ? (
            projectGroups.map((group) => {
              const collapsed = collapsedProjects[group.workspace] ?? false;
              const sortedSessions = [...group.sessions].sort(
                (left, right) =>
                  Number(pinnedSessions.includes(right.id)) -
                  Number(pinnedSessions.includes(left.id)),
              );
              const projectBusy = group.sessions.some((session) =>
                ["running", "waiting", "cancelling"].includes(
                  state?.liveSessions[session.id]?.state ?? "",
                ),
              );
              const listId = `project-sessions-${encodeURIComponent(group.workspace)}`;
              return (
                <section className="project-session-group" key={group.workspace}>
                  <div className="project-heading-row">
                    <button
                      className="project-heading"
                      title={group.workspace}
                      aria-expanded={!collapsed}
                      aria-controls={listId}
                      onClick={() =>
                        setCollapsedProjects((current) => ({
                          ...current,
                          [group.workspace]: !collapsed,
                        }))
                      }
                    >
                      <Icon
                        name="chevron"
                        className={`project-chevron ${collapsed ? "collapsed" : "expanded"}`}
                      />
                      <Icon name="folder" />
                      <span>{group.name}</span>
                    </button>
                    <button
                      ref={
                        projectMenuWorkspace === group.workspace ? projectMenuButtonRef : undefined
                      }
                      className="project-menu-button"
                      aria-label={`Project actions for ${group.name}`}
                      aria-expanded={projectMenuWorkspace === group.workspace}
                      title="Project actions"
                      onClick={() =>
                        setProjectMenuWorkspace(
                          projectMenuWorkspace === group.workspace ? undefined : group.workspace,
                        )
                      }
                    >
                      ···
                    </button>
                    {projectMenuWorkspace === group.workspace && (
                      <div className="session-menu project-menu" ref={projectMenuRef}>
                        <button
                          disabled={projectBusy}
                          title={projectBusy ? "Stop project chats before archiving" : undefined}
                          onClick={() => void archiveProject(group.workspace)}
                        >
                          Archive all chats
                        </button>
                        <button
                          className="destructive"
                          disabled={projectBusy}
                          title={projectBusy ? "Stop project chats before deleting" : undefined}
                          onClick={() => {
                            setProjectMenuWorkspace(undefined);
                            setDeleteProjectWorkspace(group.workspace);
                          }}
                        >
                          Delete project
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="project-session-items" id={listId} hidden={collapsed}>
                    {sortedSessions.map((session) => {
                      const sessionState = state?.liveSessions[session.id]?.state;
                      const isSessionBusy = ["running", "waiting", "cancelling"].includes(
                        sessionState ?? "",
                      );
                      const isPinned = pinnedSessions.includes(session.id);
                      return (
                        <div
                          key={session.id}
                          className={`session-row ${session.id === state?.activeSessionId ? "selected" : ""}`}
                        >
                          <button
                            className="session"
                            aria-current={
                              session.id === state?.activeSessionId ? "page" : undefined
                            }
                            onClick={() => void openSession(session.id)}
                          >
                            <span className="session-title" title={session.title}>
                              {session.title}
                            </span>
                          </button>
                          <div className="session-row-actions">
                            <button
                              className={`session-action-button ${isPinned ? "pinned" : ""}`}
                              aria-label={isPinned ? "Unpin chat" : "Pin chat"}
                              aria-pressed={isPinned}
                              title={isPinned ? "Unpin chat" : "Pin chat"}
                              onClick={() => togglePinnedSession(session.id)}
                            >
                              <Icon name="pin" />
                            </button>
                            <button
                              className="session-action-button"
                              aria-label="Archive chat"
                              title="Archive chat"
                              disabled={isSessionBusy}
                              onClick={() => void archiveSession(session.id)}
                            >
                              <Icon name="archive" />
                            </button>
                            {isSessionBusy && (
                              <span className="session-spinner" aria-label="Running" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          ) : (
            <p className="empty-session-list">Open a project to see sessions</p>
          )}
        </div>
        <button
          className="settings-link"
          onClick={() => {
            setSettingsSection("general");
            setSettingsOpen(true);
          }}
        >
          <Icon name="settings" /> Settings
        </button>
      </aside>

      <div
        className={`sidebar-resize-handle ${sidebarResizeActive ? "active" : ""}`}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={sidebarOpen ? 0 : -1}
        hidden={!sidebarOpen}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setSidebarResizeActive(true);
        }}
        onPointerMove={(event) => {
          if (sidebarResizeActive) resizeSidebar(event.clientX);
        }}
        onPointerUp={(event) => {
          setSidebarResizeActive(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => setSidebarResizeActive(false)}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
          setSidebarOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeSidebar(sidebarWidth - 16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeSidebar(sidebarWidth + 16);
          } else if (event.key === "Home") {
            event.preventDefault();
            resizeSidebar(SIDEBAR_MIN_WIDTH);
          } else if (event.key === "End") {
            event.preventDefault();
            resizeSidebar(SIDEBAR_MAX_WIDTH);
          }
        }}
      />

      <main className="conversation">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-expanded={sidebarOpen}
            title="Toggle sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Icon name="sidebar" />
          </button>
          <div className="workspace-title">
            <strong
              title={
                activeSession?.workspace.split("/").filter(Boolean).at(-1) ?? "Choose a project"
              }
            >
              {activeSession?.workspace.split("/").filter(Boolean).at(-1) ?? "Choose a project"}
            </strong>
            <span title={activeSession?.workspace}>
              {activeSession?.workspace ?? "Open a local folder to get started"}
            </span>
          </div>
          <div className="top-actions">
            <button
              className={`review-toggle ${reviewOpen ? "selected" : ""}`}
              disabled={!activeSession}
              title={reviewOpen ? "Close review" : "Review workspace changes"}
              aria-expanded={reviewOpen}
              aria-controls="workspace-panel"
              onClick={() => setReviewOpen(!reviewOpen)}
            >
              <Icon name="panel" /> <span>Review</span>
              {changes.length > 0 && <span className="count">{changes.length}</span>}
            </button>
          </div>
        </header>

        {!activeSession ? (
          <div className="welcome">
            <KairoLogo className="welcome-logo" />
            <h1>What should we work on?</h1>
            <p>Open a local project to start a chat with Kairo.</p>
            <button className="primary" onClick={() => void openWorkspace()}>
              Open project folder
            </button>
          </div>
        ) : (
          <>
            <section
              className="transcript"
              ref={transcriptRef}
              aria-label="Conversation"
              onScroll={(event) => {
                const node = event.currentTarget;
                followTranscript.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              }}
            >
              {messages.length === 0 && !stream && !state.task && (
                <div className="chat-start">
                  <KairoLogo className="chat-start-mark" />
                  <h1>Let’s build.</h1>
                  <p className="chat-start-copy">What would you like to work on?</p>
                  <div className="prompt-suggestions">
                    {[
                      ["Explore this project", "Give me a concise overview of this codebase."],
                      ["Find a bug", "Look for a likely bug and explain how to reproduce it."],
                      ["Build a feature", "Help me plan and implement a feature: "],
                    ].map(([label, value]) => (
                      <button key={label} onClick={() => choosePrompt(value)}>
                        <span>{label}</span>
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <ChatMessage
                  key={`${message.createdAt}-${index}`}
                  message={message}
                  agentName={externalAgent?.name ?? "Kairo"}
                />
              ))}
              {state.task?.mode === "planning" && state.task.plan && (
                <div className="plan-card">
                  <strong>Plan</strong>
                  <h3>{state.task.plan.goal}</h3>
                  <ol>
                    {state.task.plan.steps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                  {state.task.plan.files.length > 0 && (
                    <>
                      <h4>Files</h4>
                      <ul>
                        {state.task.plan.files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code> — {file.reason}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <p>
                    <b>Verification:</b>{" "}
                    {state.task.plan.verification.command ? (
                      <code>{state.task.plan.verification.command}</code>
                    ) : (
                      "No command selected"
                    )}{" "}
                    — {state.task.plan.verification.reason}
                  </p>
                  {state.task.plan.risks.length > 0 && (
                    <p>
                      <b>Risks:</b> {state.task.plan.risks.join("; ")}
                    </p>
                  )}
                </div>
              )}
              {toolActivity.length > 0 && (
                <div className="tool-activity" aria-label="Tool activity" aria-live="polite">
                  {toolActivity.map((event) => (
                    <ToolActivityRow key={event.operationId} event={event} />
                  ))}
                </div>
              )}
              {stream && (
                <div className="message assistant">
                  <div className="avatar">K</div>
                  <div className="message-body">
                    <div className="message-author">{externalAgent?.name ?? "Kairo"}</div>
                    <Markdown content={stream} />
                  </div>
                </div>
              )}
              {(busy || showWorkedDuration) && (
                <div className="working">
                  {busy && <span className="pulse" />}
                  {busy
                    ? live?.state === "waiting" || live?.state === "cancelling"
                      ? `${activity} · Working for ${elapsedSeconds}s`
                      : `Working for ${elapsedSeconds}s`
                    : `Worked for ${elapsedSeconds}s`}
                </div>
              )}
              {error && (
                <div className="error-banner">
                  {error}
                  <button onClick={() => setError("")}>Dismiss</button>
                </div>
              )}
              {userInput && (
                <UserInputCard
                  key={userInput.id}
                  request={userInput}
                  onAnswered={() => {
                    setState((current) =>
                      current
                        ? {
                            ...current,
                            userInputs: current.userInputs.filter(
                              (item) => item.id !== userInput.id,
                            ),
                          }
                        : current,
                    );
                  }}
                />
              )}
              {approval && (
                <div className="approval-card">
                  <strong>{externalAgent?.name ?? "Kairo"} needs approval</strong>
                  <pre>{approval.description}</pre>
                  <div className="approval-actions">
                    <button onClick={() => void pickApproval("deny")}>Deny</button>
                    {approval.canAllowFile && (
                      <button onClick={() => void pickApproval("task_file")}>
                        Allow file for task
                      </button>
                    )}
                    <button className="primary" onClick={() => void pickApproval("approve")}>
                      Approve
                    </button>
                  </div>
                </div>
              )}
            </section>
            <div className="composer-wrap">
              {externalAgent && (!externalAgent.authenticated || externalAgent.error) && (
                <div className="agent-setup" role="status">
                  <span>
                    {externalAgent.error || `${externalAgent.name} needs its official sign-in.`}
                  </span>
                  <button
                    disabled={agentSetupBusy || loginPending}
                    onClick={() => void loginAgent()}
                  >
                    {loginPending ? "Waiting for sign-in…" : `Sign in to ${externalAgent.name}`}
                  </button>
                  <button
                    disabled={agentSetupBusy}
                    onClick={() =>
                      void refreshAgents().catch((cause) => setError((cause as Error).message))
                    }
                  >
                    Check sign-in
                  </button>
                </div>
              )}
              {state.liveSessions[state.activeSessionId!]?.error && (
                <p className="error" role="alert">
                  {state.liveSessions[state.activeSessionId!]?.error}
                </p>
              )}
              {activeSession.runtime.kind === "external" &&
                state.task?.status === "verification_required" && (
                  <p className="agent-note">
                    Agent turn finished. Workspace changes still need verification.
                  </p>
                )}
              <div className="composer">
                {commandSuggestions.length > 0 && !busy && (
                  <div className="codex-command-menu" role="listbox" aria-label="Codex commands">
                    {commandSuggestions.map((item, index) => (
                      <button
                        key={item.key}
                        className={index === commandIndex ? "selected" : ""}
                        role="option"
                        aria-selected={index === commandIndex}
                        onMouseEnter={() => setCommandIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setPrompt(item.value)}
                      >
                        <span className="codex-command-name">{item.title}</span>
                        <span className="codex-command-description">{item.description}</span>
                      </button>
                    ))}
                    <span className="codex-command-hint">↑ ↓ to navigate · Enter to select</span>
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (commandSuggestions.length && event.key === "ArrowDown") {
                      event.preventDefault();
                      setCommandIndex((index) => (index + 1) % commandSuggestions.length);
                      return;
                    }
                    if (commandSuggestions.length && event.key === "ArrowUp") {
                      event.preventDefault();
                      setCommandIndex(
                        (index) =>
                          (index - 1 + commandSuggestions.length) % commandSuggestions.length,
                      );
                      return;
                    }
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      const typedName = prompt.trim().split(/\s+/)[0];
                      const hasModelArgument = /^\/model\s+\S/.test(prompt.trim());
                      const exactCommand = codexCommands.some((item) => item.name === typedName);
                      if (
                        commandSuggestions.length &&
                        (!exactCommand || (typedName === "/model" && !hasModelArgument))
                      ) {
                        setPrompt(
                          commandSuggestions[commandIndex % commandSuggestions.length]!.value,
                        );
                        return;
                      }
                      void sendTask();
                    }
                  }}
                  placeholder={`Ask ${externalAgent?.name ?? "Kairo"} to work on your project…`}
                  aria-label={`Message ${externalAgent?.name ?? "Kairo"}`}
                  rows={1}
                />
                <div className="composer-footer">
                  <div className="composer-controls">
                    <select
                      aria-label="Task agent"
                      title={
                        busy
                          ? "Switching stops the current agent and prepares a context handoff"
                          : "Choose the agent for this conversation"
                      }
                      disabled={agentSetupBusy}
                      value={
                        activeSession.runtime.kind === "builtin"
                          ? "builtin"
                          : activeSession.runtime.agentId
                      }
                      onChange={(event) =>
                        void chooseRuntime(
                          event.target.value === "builtin"
                            ? { kind: "builtin", selection: state.config }
                            : { kind: "external", agentId: event.target.value },
                        )
                      }
                    >
                      <option value="builtin">Kairo</option>
                      {state.agents.map((agent) => (
                        <option
                          key={agent.id}
                          value={agent.id}
                          disabled={!agent.installed || Boolean(agent.error)}
                        >
                          {agent.name}
                          {!agent.installed || agent.error ? " · setup required" : ""}
                        </option>
                      ))}
                    </select>
                    {isCodexSession ? (
                      <select
                        aria-label="Codex collaboration mode"
                        value={codexMode}
                        onChange={(event) =>
                          void setCodexMode(event.target.value as "default" | "plan")
                        }
                        disabled={busy}
                      >
                        <option value="default">Default</option>
                        <option value="plan">Plan</option>
                      </select>
                    ) : activeSession.runtime.kind !== "external" ? (
                      <select
                        aria-label="Task mode"
                        value={mode}
                        onChange={(event) => setMode(event.target.value as Mode)}
                        disabled={busy}
                      >
                        <option value="build">Build</option>
                        <option value="plan">Plan</option>
                      </select>
                    ) : null}
                    {activeSession.runtime.kind === "external" ? (
                      <select
                        aria-label="Agent model"
                        disabled={busy || agentSetupBusy}
                        value={activeSession.runtime.model ?? ""}
                        onChange={(event) =>
                          void chooseRuntime({
                            kind: "external",
                            agentId:
                              activeSession.runtime.kind === "external"
                                ? activeSession.runtime.agentId
                                : "",
                            model: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">Agent default model</option>
                        {externalAgent?.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        className="composer-model-select"
                        aria-label="Model"
                        disabled={busy || modelSaving}
                        title={`${state.providers.find((provider) => provider.id === activeModelSelection?.provider)?.name ?? activeModelSelection?.provider} / ${activeModelSelection?.model}`}
                        value={JSON.stringify([
                          activeModelSelection?.provider ?? state.config.provider,
                          activeModelSelection?.model ?? state.config.model,
                        ])}
                        onChange={(event) => {
                          if (event.target.value === "__settings") {
                            setSelection(activeModelSelection ?? state.config);
                            setSettingsSection("models");
                            setSettingsOpen(true);
                            return;
                          }
                          try {
                            const [provider, model] = JSON.parse(event.target.value) as [
                              string,
                              string,
                            ];
                            void chooseComposerModel({
                              provider: provider as ModelSelection["provider"],
                              model,
                            });
                          } catch {
                            setError("Choose a valid model.");
                          }
                        }}
                      >
                        {state.providers.map((provider) => (
                          <optgroup key={provider.id} label={provider.name}>
                            {provider.models.map((model) => (
                              <option
                                key={model.id}
                                value={JSON.stringify([provider.id, model.id])}
                              >
                                {model.label}
                                {!provider.hasCredential ? " · set up key" : ""}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                        <option value="__settings">Manage models and API keys…</option>
                      </select>
                    )}
                  </div>
                  <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
                  {busy ? (
                    <button
                      className="stop-button"
                      aria-label="Stop task"
                      title="Stop task (Esc)"
                      onClick={() => void window.kairo.cancel(state.activeSessionId!)}
                    >
                      <Icon name="stop" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      title="Send message"
                      onClick={() => void sendTask()}
                      disabled={
                        !prompt.trim() ||
                        agentSetupBusy ||
                        (activeSession.runtime.kind === "external" &&
                          (!externalAgent?.authenticated || Boolean(externalAgent.error)))
                      }
                    >
                      <Icon name="arrow" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <aside
        className="workbench"
        id="workspace-panel"
        aria-label="Workspace review"
        hidden={!reviewOpen}
      >
        <div className="workbench-tabs">
          <span className="review-heading">
            Changes{" "}
            <span>
              {changes.length} {changes.length === 1 ? "file" : "files"}
            </span>
          </span>
          <button
            className="refresh-button"
            aria-label="Refresh changed files"
            onClick={() => void refreshChanges()}
            title="Refresh"
          >
            <Icon name="refresh" />
          </button>
          <button
            className="icon-button"
            aria-label="Close review"
            onClick={() => setReviewOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        {viewingChanges ? (
          <section className="change-detail">
            <div className="change-detail-header">
              <button className="back-to-changes" onClick={() => setViewingChanges(false)}>
                ← All changes
              </button>
              <strong>
                {changes.length} {changes.length === 1 ? "file" : "files"} changed
              </strong>
              <span className="change-summary-stats">
                <span className="addition-count">
                  +{changes.reduce((total, item) => total + item.additions, 0)}
                </span>
                <span className="deletion-count">
                  −{changes.reduce((total, item) => total + item.deletions, 0)}
                </span>
              </span>
            </div>
            <div className="diff-scroll">
              {changes.map((change) => (
                <article className="file-diff-section" key={change.path}>
                  <header className="file-diff-header">
                    <span className="filetype-mark">{fileExtension(change.path)}</span>
                    <strong title={change.path}>{change.path}</strong>
                    <span className="change-summary-stats">
                      <span className="addition-count">+{change.additions}</span>
                      <span className="deletion-count">−{change.deletions}</span>
                    </span>
                    <button
                      className="cursor-button"
                      onClick={() => void openInCursor(change.path)}
                    >
                      Open in Cursor
                    </button>
                  </header>
                  {change.unavailable && <div className="diff-notice">{change.unavailable}</div>}
                  <div className="diff-rows-wrap">
                    <DiffContents diff={change.diff} />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="changes-overview">
            <div className="changes-overview-title">
              <span>Edited files</span>
              <button
                className="view-changes-button"
                disabled={!changes.length}
                onClick={() => setViewingChanges(true)}
              >
                View changes ↗
              </button>
            </div>
            {changes.length ? (
              <div className="change-summary-list">
                {changes.map((change) => (
                  <div className="change-summary-row" key={change.path}>
                    <div className="change-summary-file" title={change.path}>
                      <span className="filetype-mark">{fileExtension(change.path)}</span>
                      <span>{change.path}</span>
                    </div>
                    <div className="change-summary-stats">
                      <span className="addition-count">+{change.additions}</span>
                      <span className="deletion-count">−{change.deletions}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-small">No working tree changes</div>
            )}
          </section>
        )}
      </aside>
      {activeSession && (
        <UsageFooter
          sessionId={activeSession.id}
          agentId={
            activeSession.runtime.kind === "external" ? activeSession.runtime.agentId : undefined
          }
          name={
            activeSession.runtime.kind === "external"
              ? (externalAgent?.name ?? activeSession.runtime.agentId)
              : (state?.providers.find((provider) => provider.id === activeModelSelection?.provider)
                  ?.name ?? "Kairo")
          }
          model={
            activeSession.runtime.kind === "external"
              ? activeSession.runtime.model
              : activeModelSelection?.model
          }
        />
      )}

      {newSessionOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewSessionOpen(false);
          }}
        >
          <div
            className="confirm-dialog session-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-session-title"
          >
            <h2 id="new-session-title">New agent session</h2>
            <p>Choose an agent or model, then select the project folder it can work in.</p>
            <div className="session-folder-picker">
              <span className="session-picker-caption">Project folder</span>
              <button
                autoFocus
                aria-label="Choose project folder"
                title={newSessionWorkspace || "Choose the project folder for this session"}
                onClick={() => void pickSessionWorkspace()}
                disabled={workspacePickerBusy}
              >
                <Icon name="folder" />
                {workspacePickerBusy
                  ? "Choose a folder…"
                  : newSessionWorkspace
                    ? newSessionWorkspace.split("/").filter(Boolean).at(-1)
                    : "Choose folder"}
              </button>
              {newSessionWorkspace && (
                <small title={newSessionWorkspace}>{newSessionWorkspace}</small>
              )}
            </div>
            <label className="session-picker-label">
              Agent or model
              <select
                value={newSessionChoice}
                onChange={(event) => setNewSessionChoice(event.target.value)}
              >
                <option value="">Select an agent or model</option>
                <optgroup label="Agents">
                  {state?.agents.map((agent) => (
                    <option
                      key={agent.id}
                      value={JSON.stringify(["agent", agent.id])}
                      disabled={!agent.installed}
                    >
                      {agent.name}
                      {!agent.installed ? " · not installed" : ""}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Models">
                  {state?.providers.flatMap((provider) =>
                    provider.models.map((model) => (
                      <option
                        key={`${provider.id}:${model.id}`}
                        value={JSON.stringify(["model", provider.id, model.id])}
                      >
                        {provider.name} · {model.label}
                      </option>
                    )),
                  )}
                </optgroup>
              </select>
            </label>
            <button
              className="refresh-agents-button"
              onClick={() =>
                void refreshAgents().catch((cause) => setError((cause as Error).message))
              }
              disabled={agentSetupBusy}
            >
              Refresh agents
            </button>
            <div>
              <button onClick={() => setNewSessionOpen(false)}>Cancel</button>
              <button
                className="primary"
                disabled={!newSessionChoice || !newSessionWorkspace || workspacePickerBusy}
                onClick={createSelectedSession}
              >
                Start session
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteProjectWorkspace && (
        <div className="modal-backdrop">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <h2 id="delete-project-title">Delete project?</h2>
            <p>
              This permanently deletes all active and archived chats and task history for this
              project. Files in the folder will remain.
            </p>
            <code className="project-delete-path">{deleteProjectWorkspace}</code>
            <div>
              <button onClick={() => setDeleteProjectWorkspace(undefined)}>Cancel</button>
              <button
                className="destructive-button"
                disabled={projectDeleteBusy}
                onClick={() => void deleteProject(deleteProjectWorkspace)}
              >
                {projectDeleteBusy ? "Deleting…" : "Delete project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KairoLogo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={`kairo-logo ${className ?? ""}`}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M18 4 6 16l6 6M14 28l12-12-6-6"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeleteChatDialog({
  title,
  description,
  busy,
  error,
  onCancel,
  onConfirm,
  confirmLabel,
}: {
  title: string;
  description: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previouslyFocused?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog archive-confirm-dialog"
      aria-labelledby="archive-delete-title"
      aria-describedby="archive-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <div className="dialog-danger-icon">
        <Icon name="trash" />
      </div>
      <h2 id="archive-delete-title">{title}</h2>
      <p id="archive-delete-description">{description} This cannot be undone.</p>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button autoFocus disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="destructive-button" disabled={busy} onClick={onConfirm}>
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

function ToolActivityRow({ event }: { event: TaskEvent }): React.JSX.Element {
  const labels: Record<string, string> = {
    list_files: "Listing files",
    read_file: "Reading file",
    read_file_range: "Reading file",
    search_files: "Searching files",
    write_file: "Writing file",
    edit_file: "Editing file",
    run_command: "Running command",
    commandExecution: "Running command",
    fileChange: "Editing files",
    mcpToolCall: "Calling tool",
    webSearch: "Searching web",
    submit_plan: "Saving plan",
  };
  const label = labels[event.name ?? ""] ?? (event.name ? `Using ${event.name}` : "Tool activity");
  const state =
    event.kind === "tool_started" ? "Running" : event.outcome === "succeeded" ? "Done" : "Failed";
  return (
    <div className={`tool-activity-row ${state.toLowerCase()}`}>
      <span className="tool-activity-dot" />
      <span>{label}</span>
      <span className="tool-activity-status">{state}</span>
    </div>
  );
}

function Markdown({ content }: { content: string }): React.JSX.Element {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock key={blocks.length} code={code.join("\n")} language={fence[1] ?? ""} />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        React.createElement(`h${level}`, { key: blocks.length }, inlineMarkdown(heading[2]!)),
      );
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} />);
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!))
        quote.push(lines[index++]!.replace(/^\s*>\s?/, ""));
      blocks.push(
        <blockquote key={blocks.length}>
          <Markdown content={quote.join("\n")} />
        </blockquote>,
      );
      continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(item[3]!);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={blocks.length}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inlineMarkdown(item)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !/^\s*```/.test(lines[index]!) &&
      !/^(#{1,6})\s/.test(lines[index]!) &&
      !/^\s*>/.test(lines[index]!) &&
      !/^\s*(?:[-+*]|\d+\.)\s+/.test(lines[index]!)
    )
      paragraph.push(lines[index++]!);
    blocks.push(
      <p key={blocks.length}>
        {paragraph.map((part, partIndex) => (
          <React.Fragment key={partIndex}>
            {partIndex > 0 && <br />}
            {inlineMarkdown(part)}
          </React.Fragment>
        ))}
      </p>,
    );
  }
  return <div className="markdown-body">{blocks}</div>;
}

function inlineMarkdown(text: string): React.ReactNode[] {
  const token =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*]+\*(?!\*)|(?<!_)_[^_]+_(?!_)|\[[^\]]+\]\([^)]+\))/g;
  const result: React.ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(token)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (start > offset) result.push(text.slice(offset, start));
    const key = `inline-${start}`;
    if (value.startsWith("`")) result.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith("**") || value.startsWith("__"))
      result.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith("*") || value.startsWith("_"))
      result.push(<em key={key}>{value.slice(1, -1)}</em>);
    else {
      const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      const safe = /^(https?:|mailto:|#|\/)/i.test(link[2]!);
      result.push(
        safe ? (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          link[1]
        ),
      );
    }
    offset = start + value.length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}

function CodeBlock({ code, language }: { code: string; language: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || "Code"}</span>
        <button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ChatMessage({
  message,
  agentName,
}: {
  message: Message;
  agentName: string;
}): React.JSX.Element {
  const internalUserLabel =
    message.role !== "user"
      ? undefined
      : /^Automatic recovery attempt \d+\/\d+:/.test(message.content)
        ? "Recovery"
        : message.content.startsWith("Resume the interrupted task:")
          ? "Continuing task"
          : undefined;
  const user = message.role === "user" && !internalUserLabel;
  const author = internalUserLabel ?? (user ? "You" : (message.agentName ?? agentName));
  return (
    <div className={`message ${user ? "user" : "assistant"}`}>
      <div className="avatar">{user ? "Y" : "K"}</div>
      <div className="message-body">
        <div className="message-author">{author}</div>
        {message.toolName === "agent_handoff" ? (
          <details className="agent-handoff">
            <summary>{message.content.split("\n")[0]}</summary>
            <Markdown content={message.content.split("\n\n").slice(1).join("\n\n")} />
          </details>
        ) : user ? (
          <div className="message-text">{message.content}</div>
        ) : (
          <Markdown content={message.content} />
        )}
      </div>
    </div>
  );
}

type IconName =
  | "plus"
  | "check"
  | "trash"
  | "folder"
  | "pin"
  | "archive"
  | "settings"
  | "sidebar"
  | "panel"
  | "close"
  | "refresh"
  | "arrow"
  | "stop"
  | "chevron";
function Icon({ name, className }: { name: IconName; className?: string }): React.JSX.Element {
  const paths: Record<IconName, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" />
      </>
    ),
    folder: <path d="M3 7V5h6l2 2h10v12H3Z" />,
    pin: (
      <>
        <path d="m16 3 5 5-4 1-3 5-4-4 5-3 1-4Z" />
        <path d="m2 22 8-8" />
      </>
    ),
    archive: (
      <>
        <path d="M3 4h18v4H3z" />
        <path d="M5 8v12h14V8M10 12h4" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15" />
      </>
    ),
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" />,
    chevron: <path d="m6 9 6 6 6-6" />,
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
