import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopBootstrap, LiveSession } from "../../shared/api.js";
import type { SessionRuntime } from "../../../../domain/agent-runtime.js";
import type { ModelSelection, Message, TaskEvent } from "../../../../domain/models.js";

type Mode = "build" | "plan";
type Pane = "files" | "changes";
type Theme = "light" | "dark";
type SettingsSection = "general" | "models" | "archived";

export function DesktopApp(): React.JSX.Element {
  const [state, setState] = useState<DesktopBootstrap>();
  const [, setClock] = useState(0);
  const activeSession = state?.sessions.find((item) => item.id === state.activeSessionId);
  const live = state?.activeSessionId ? state.liveSessions[state.activeSessionId] : undefined;
  const busy = Boolean(live && ["running", "waiting", "cancelling"].includes(live.state));
  const stream = busy ? (live?.stream ?? "") : "";
  const toolActivity = live?.events ?? [];
  const activity =
    live?.state === "waiting"
      ? "Waiting for approval"
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
  const runtimeLocked = Boolean(state?.messages.length || activeSession?.externalSessionId);
  const workspaceBusy = Boolean(
    state?.sessions.some(
      (session) =>
        session.workspace === activeSession?.workspace &&
        ["running", "waiting", "cancelling"].includes(state.liveSessions[session.id]?.state),
    ),
  );
  const [agentSetupBusy, setAgentSetupBusy] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const prompt = state?.activeSessionId ? (drafts[state.activeSessionId] ?? "") : "";
  const setPrompt = (text: string) => {
    if (state?.activeSessionId)
      setDrafts((current) => ({ ...current, [state.activeSessionId!]: text }));
  };
  const [mode, setMode] = useState<Mode>("build");
  const [pane, setPane] = useState<Pane>("changes");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recentChatsOpen, setRecentChatsOpen] = useState(() => {
    try {
      return window.localStorage.getItem("kairo.recentChatsOpen") !== "false";
    } catch {
      return true;
    }
  });
  const [files, setFiles] = useState<string[]>([]);
  const [changes, setChanges] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [diff, setDiff] = useState("");
  const [diffNotice, setDiffNotice] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [sessionMenuId, setSessionMenuId] = useState<string>();
  const [deleteSessionId, setDeleteSessionId] = useState<string>();
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followTranscript = useRef(true);
  const activeSessionRef = useRef<string | undefined>(undefined);
  const navigationRevision = useRef(0);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setClock((clock) => clock + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

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
      window.localStorage.setItem("kairo.recentChatsOpen", String(recentChatsOpen));
    } catch {
      // Keep the state for this window if storage is unavailable.
    }
  }, [recentChatsOpen]);

  const applyState = useCallback((next: DesktopBootstrap) => {
    activeSessionRef.current = next.activeSessionId;
    setState(next);
    setSelection(next.config);
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
        const [listed, changed] = await Promise.all([
          window.kairo.listFiles(next.activeSessionId),
          window.kairo.changedFiles(next.activeSessionId),
        ]);
        if (activeSessionRef.current !== next.activeSessionId) return;
        setFiles(listed);
        setChanges(changed);
      } else {
        setFiles([]);
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
      setSelectedFile("");
      setFileContent("");
      setSavedContent("");
      if (next.activeSessionId) {
        const [listed, changed] = await Promise.all([
          window.kairo.listFiles(next.activeSessionId),
          window.kairo.changedFiles(next.activeSessionId),
        ]);
        if (activeSessionRef.current !== next.activeSessionId) return;
        setFiles(listed);
        setChanges(changed);
      } else {
        setFiles([]);
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

  const newSession = async () => {
    if (!activeSession) return;
    const revision = ++navigationRevision.current;
    try {
      const next = await window.kairo.newSession(activeSession.runtime);
      if (revision === navigationRevision.current) await focusSession(next);
    } catch (cause) {
      setError((cause as Error).message);
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
    const stopRuntimeError = window.kairo.onRuntimeError(({ error: message }) => {
      setError(message);
      setState((current) =>
        current
          ? {
              ...current,
              approvals: [],
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
    try {
      applyState(await window.kairo.setRuntime(activeSession.id, runtime));
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
  }, [state?.messages, stream]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteSessionId) setDeleteSessionId(undefined);
      else if (settingsOpen) setSettingsOpen(false);
      else if (busy && state?.activeSessionId) {
        void window.kairo.cancel(state.activeSessionId).catch((cause) => setError(String(cause)));
      } else setReviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, deleteSessionId, busy, state?.activeSessionId]);

  const messages = useMemo(
    () =>
      state?.messages.filter(
        (item) => (item.role === "user" || item.role === "model") && !item.toolCallId,
      ) ?? [],
    [state?.messages],
  );

  const openFile = async (path: string, review = false) => {
    if (!state?.activeSessionId) return;
    try {
      if (review) {
        const result = await window.kairo.diff(state.activeSessionId, path);
        if (activeSessionRef.current !== state.activeSessionId) return;
        setDiff(result.diff);
        setDiffNotice(result.unavailable ?? "");
      } else {
        const content = await window.kairo.readFile(state.activeSessionId, path);
        if (activeSessionRef.current !== state.activeSessionId) return;
        setFileContent(content);
        setSavedContent(content);
      }
      setSelectedFile(path);
      setShowDiff(review);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const refreshChanges = async () => {
    if (!state?.activeSessionId) return;
    try {
      const [changed, listed] = await Promise.all([
        window.kairo.changedFiles(state.activeSessionId),
        window.kairo.listFiles(state.activeSessionId),
      ]);
      setChanges(changed);
      setFiles(listed);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const sendTask = async () => {
    if (!state?.activeSessionId || !prompt.trim() || busy) return;
    const text = prompt.trim();
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
      await window.kairo.send(state.activeSessionId, text, mode);
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
    try {
      const next = await window.kairo.saveModel(selection, apiKey);
      setApiKey("");
      applyState(next);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const changeSession = async (action: "archive" | "delete", sessionId: string) => {
    try {
      const next =
        action === "archive"
          ? await window.kairo.archiveSession(sessionId)
          : await window.kairo.deleteSession(sessionId);
      setSessionMenuId(undefined);
      setDeleteSessionId(undefined);
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

  if (settingsOpen)
    return (
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
              onClick={() => setSettingsSection(section)}
            >
              {section === "general"
                ? "General"
                : section === "models"
                  ? "Models"
                  : "Archived chats"}
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
                  value={selection.provider}
                  onChange={(event) => {
                    const provider = state.providers.find((item) => item.id === event.target.value);
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
                  value={selection.model}
                  onChange={(event) =>
                    setSelection((current) => ({ ...current, model: event.target.value }))
                  }
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
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    state.hasCredential
                      ? "Saved in macOS Keychain"
                      : state.providers.find((item) => item.id === selection.provider)
                          ?.environmentVariable
                  }
                />
              </label>
              <p>Your key is validated and saved in macOS Keychain.</p>
              <button className="primary" onClick={() => void chooseModel()}>
                Save model
              </button>
            </section>
          )}
          {settingsSection === "archived" && (
            <section className="settings-card archived-list">
              {state.archivedSessions.length ? (
                state.archivedSessions.map((session) => (
                  <div className="archived-row" key={session.id}>
                    <div>
                      <strong>
                        {session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace}
                      </strong>
                      <small>{session.workspace}</small>
                    </div>
                    <button onClick={() => void restoreSession(session.id)}>Restore</button>
                  </div>
                ))
              ) : (
                <p className="empty-settings">Archived chats will appear here.</p>
              )}
            </section>
          )}
          {error && <p className="settings-error">{error}</p>}
        </main>
      </div>
    );

  return (
    <div
      className={`app-shell ${reviewOpen ? "review-open" : ""} ${sidebarOpen ? "" : "sidebar-closed"}`}
      data-theme={theme}
    >
      <aside className="sidebar" aria-label="Chats" hidden={!sidebarOpen}>
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>Kairo</span>
        </div>
        <button className="new-chat" onClick={() => void newSession()} disabled={!activeSession}>
          <Icon name="plus" /> New chat
        </button>
        <button className="open-project-button" onClick={() => void openWorkspace()}>
          <Icon name="folder" /> Open project
        </button>
        <button
          className="section-label"
          aria-expanded={recentChatsOpen}
          aria-controls="recent-chats-list"
          onClick={() => setRecentChatsOpen((open) => !open)}
        >
          <span>Recent chats</span>
          <Icon name="chevron" className={recentChatsOpen ? "expanded" : "collapsed"} />
        </button>
        <div className="session-list" id="recent-chats-list" hidden={!recentChatsOpen}>
          {state.sessions.map((session) => (
            <div
              key={session.id}
              className={`session-row ${session.id === state.activeSessionId ? "selected" : ""}`}
            >
              <button className="session" onClick={() => void openSession(session.id)}>
                <span>
                  {session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace}
                </span>
                <small>
                  {session.runtime.kind === "builtin" ? "Kairo" : session.runtime.agentId} ·{" "}
                  {state.liveSessions[session.id]?.state ?? "idle"}
                </small>
              </button>
              <button
                className="session-menu-button"
                aria-label="Chat actions"
                title="Chat actions"
                onClick={() =>
                  setSessionMenuId(sessionMenuId === session.id ? undefined : session.id)
                }
              >
                ···
              </button>
              {sessionMenuId === session.id && (
                <div className="session-menu">
                  <button
                    disabled={["running", "waiting", "cancelling"].includes(
                      state.liveSessions[session.id]?.state,
                    )}
                    onClick={() => void changeSession("archive", session.id)}
                  >
                    Archive
                  </button>
                  <button
                    className="destructive"
                    disabled={["running", "waiting", "cancelling"].includes(
                      state.liveSessions[session.id]?.state,
                    )}
                    onClick={() => {
                      setSessionMenuId(undefined);
                      setDeleteSessionId(session.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
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
            <strong>
              {activeSession?.workspace.split("/").filter(Boolean).at(-1) ?? "Choose a project"}
            </strong>
            <span>{activeSession?.workspace ?? "Open a local folder to get started"}</span>
          </div>
          <div className="top-actions">
            <button
              className={`review-toggle ${reviewOpen ? "selected" : ""}`}
              disabled={!activeSession}
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
            <div className="welcome-logo">K</div>
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
                  <div className="chat-start-mark">K</div>
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
                    ? activity === "Waiting for approval" || activity === "Stopping…"
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
              {runtimeLocked && (
                <p className="agent-note">Create a new chat to use a different agent.</p>
              )}
              <div className="runtime-picker">
                <label>
                  Agent{" "}
                  <select
                    aria-label="Session agent"
                    disabled={busy || agentSetupBusy || runtimeLocked}
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
                    <option value="builtin">Kairo · API key</option>
                    {state.agents.map((agent) => (
                      <option key={agent.id} value={agent.id} disabled={!agent.installed}>
                        {agent.name}
                        {!agent.installed ? " · not installed" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() =>
                    void refreshAgents().catch((cause) => setError((cause as Error).message))
                  }
                  disabled={agentSetupBusy}
                >
                  Refresh agents
                </button>
              </div>
              <div className="composer">
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void sendTask();
                    }
                  }}
                  placeholder={`Ask ${externalAgent?.name ?? "Kairo"} to work on your project…`}
                  aria-label="Message Kairo"
                  rows={3}
                />
                <div className="composer-footer">
                  <div className="composer-controls">
                    <select
                      aria-label="Task mode"
                      value={mode}
                      onChange={(event) => setMode(event.target.value as Mode)}
                      disabled={busy}
                    >
                      <option value="build">Build</option>
                      <option value="plan">Plan</option>
                    </select>
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
                      <button
                        className="model-button"
                        disabled={busy}
                        title={`${state.config.provider} / ${state.config.model}`}
                        onClick={() => {
                          setSettingsSection("models");
                          setSettingsOpen(true);
                        }}
                      >
                        {state.config.model}
                        <span aria-hidden="true">⌄</span>
                      </button>
                    )}
                  </div>
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
          <button className={pane === "changes" ? "active" : ""} onClick={() => setPane("changes")}>
            Changes <span>{changes.length}</span>
          </button>
          <button className={pane === "files" ? "active" : ""} onClick={() => setPane("files")}>
            Files
          </button>
          <button className="refresh-button" onClick={() => void refreshChanges()} title="Refresh">
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
        {pane === "changes" ? (
          <div className="file-list">
            {changes.length ? (
              changes.map((path) => (
                <button
                  key={path}
                  className={`file-row ${selectedFile === path ? "selected" : ""}`}
                  onClick={() => void openFile(path, true)}
                >
                  <span className="change-dot" />
                  {path}
                </button>
              ))
            ) : (
              <div className="empty-small">No working tree changes</div>
            )}
          </div>
        ) : (
          <div className="file-list">
            {files.map((path) => (
              <button
                key={path}
                className={`file-row ${selectedFile === path ? "selected" : ""}`}
                onClick={() => void openFile(path)}
              >
                {path}
              </button>
            ))}
          </div>
        )}
        <div className="editor-area">
          {selectedFile ? (
            <>
              <div className="editor-heading">
                <span title={selectedFile}>{selectedFile}</span>
                <div>
                  {pane === "changes" && (
                    <button onClick={() => void openFile(selectedFile, !showDiff)}>
                      {showDiff ? "Edit" : "Diff"}
                    </button>
                  )}
                  {!showDiff && (
                    <button
                      className="save-button"
                      disabled={workspaceBusy || fileContent === savedContent}
                      onClick={async () => {
                        try {
                          await window.kairo.saveFile(
                            state.activeSessionId!,
                            selectedFile,
                            fileContent,
                          );
                          setSavedContent(fileContent);
                          await refreshChanges();
                        } catch (cause) {
                          setError((cause as Error).message);
                        }
                      }}
                    >
                      Save
                    </button>
                  )}
                </div>
              </div>
              {showDiff ? (
                <>
                  <div className="diff-notice">{diffNotice}</div>
                  <pre className="diff-content">
                    {diff.split("\n").map((line, index) => (
                      <div
                        key={index}
                        className={
                          line.startsWith("+")
                            ? "diff-add"
                            : line.startsWith("-")
                              ? "diff-remove"
                              : ""
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                </>
              ) : (
                <textarea
                  className="editor"
                  aria-label={selectedFile}
                  readOnly={workspaceBusy}
                  wrap="off"
                  value={fileContent}
                  onChange={(event) => setFileContent(event.target.value)}
                  spellCheck={false}
                />
              )}
            </>
          ) : (
            <div className="empty-editor">Select a file to view or edit it.</div>
          )}
        </div>
      </aside>

      {deleteSessionId && (
        <div className="modal-backdrop">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-chat-title"
          >
            <h2 id="delete-chat-title">Delete this chat?</h2>
            <p>This permanently deletes the conversation and its task history.</p>
            <div>
              <button onClick={() => setDeleteSessionId(undefined)}>Cancel</button>
              <button
                className="destructive-button"
                onClick={() => void changeSession("delete", deleteSessionId)}
              >
                Delete chat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
  const author = internalUserLabel ?? (user ? "You" : agentName);
  return (
    <div className={`message ${user ? "user" : "assistant"}`}>
      <div className="avatar">{user ? "Y" : "K"}</div>
      <div className="message-body">
        <div className="message-author">{author}</div>
        {user ? (
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
  | "folder"
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
    folder: <path d="M3 7V5h6l2 2h10v12H3Z" />,
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
