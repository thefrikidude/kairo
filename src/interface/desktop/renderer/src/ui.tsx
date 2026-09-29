import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApproval, DesktopBootstrap } from "../../shared/api.js";
import type { ModelSelection, Message } from "../../../../domain/models.js";

type Mode = "build" | "plan";
type Pane = "files" | "changes";
type Theme = "light" | "dark";
type SettingsSection = "general" | "models" | "archived";

export function DesktopApp(): React.JSX.Element {
  const [state, setState] = useState<DesktopBootstrap>();
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [stream, setStream] = useState("");
  const [prompt, setPrompt] = useState("");
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
  const [approval, setApproval] = useState<DesktopApproval>();
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
    setState(next);
    setSelection(next.config);
    setError("");
  }, []);

  const reload = useCallback(
    async (sessionId?: string) => {
      const next = await window.kairo.bootstrap();
      if (sessionId && next.activeSessionId !== sessionId) return;
      applyState(next);
      if (next.activeSessionId) {
        const [listed, changed] = await Promise.all([
          window.kairo.listFiles(next.activeSessionId),
          window.kairo.changedFiles(next.activeSessionId),
        ]);
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
      setBusy(false);
      setActivity("");
      setStream("");
      setApproval(undefined);
      followTranscript.current = true;
      setSelectedFile("");
      setFileContent("");
      setSavedContent("");
      if (next.activeSessionId) {
        const [listed, changed] = await Promise.all([
          window.kairo.listFiles(next.activeSessionId),
          window.kairo.changedFiles(next.activeSessionId),
        ]);
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
    try {
      await focusSession(await window.kairo.openWorkspace());
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openSession = async (sessionId: string) => {
    if (busy) return;
    try {
      await focusSession(await window.kairo.openSession(sessionId));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const newSession = async () => {
    if (!activeSession || busy) return;
    try {
      await focusSession(await window.kairo.newSession());
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  useEffect(() => {
    void reload().catch((cause) => setError((cause as Error).message));
    const stopChunk = window.kairo.onChunk(({ sessionId, chunk }) => {
      if (sessionId === state?.activeSessionId && chunk !== "\n[Plan saved]\n")
        setStream((current) => current + chunk);
    });
    const stopState = window.kairo.onTaskState((event) => {
      if (event.sessionId !== state?.activeSessionId) return;
      if (event.state === "running") {
        setBusy(true);
        setActivity("Working");
        setStream("");
      } else if (event.state === "cancelling") {
        setActivity("Stopping…");
      } else {
        setBusy(false);
        setActivity("");
        setStream("");
        void reload(event.sessionId).finally(() => {
          if (event.error) setError(event.error!);
        });
      }
    });
    const stopApproval = window.kairo.onApproval((request) => {
      setApproval(request);
      setActivity("Waiting for approval");
    });
    return () => {
      stopChunk();
      stopState();
      stopApproval();
    };
  }, [reload, state?.activeSessionId]);

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

  const activeSession = state?.sessions.find((item) => item.id === state.activeSessionId);
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
        setDiff(result.diff);
        setDiffNotice(result.unavailable ?? "");
      } else {
        const content = await window.kairo.readFile(state.activeSessionId, path);
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
    setStream("");
    setState((current) =>
      current
        ? {
            ...current,
            messages: [...current.messages, { role: "user", content: text, createdAt: Date.now() }],
          }
        : current,
    );
    setBusy(true);
    setActivity(mode === "plan" ? "Planning" : "Starting");
    setError("");
    try {
      await window.kairo.send(state.activeSessionId, text, mode);
    } catch (cause) {
      setBusy(false);
      setActivity("");
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
    setApproval(undefined);
    setActivity("Working");
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
        <button
          className="new-chat"
          onClick={() => void newSession()}
          disabled={!activeSession || busy}
        >
          <Icon name="plus" /> New chat
        </button>
        <button
          className="open-project-button"
          onClick={() => void openWorkspace()}
          disabled={busy}
        >
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
              <button
                className="session"
                onClick={() => void openSession(session.id)}
                disabled={busy}
              >
                <span>
                  {session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace}
                </span>
                <small>{new Date(session.updatedAt).toLocaleDateString()}</small>
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
                  <button disabled={busy} onClick={() => void changeSession("archive", session.id)}>
                    Archive
                  </button>
                  <button
                    className="destructive"
                    disabled={busy}
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
                <ChatMessage key={`${message.createdAt}-${index}`} message={message} />
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
              {stream && (
                <div className="message assistant">
                  <div className="avatar">K</div>
                  <div className="message-body">
                    <div className="message-author">Kairo</div>
                    <pre className="stream-text">{stream}</pre>
                  </div>
                </div>
              )}
              {busy && (
                <div className="working">
                  <span className="pulse" />
                  {activity || "Working"}
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
                  <strong>Kairo needs approval</strong>
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
                  placeholder="Ask Kairo to work on your project…"
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
                    <button
                      className="model-button"
                      title={`${state.config.provider} / ${state.config.model}`}
                      onClick={() => {
                        setSettingsSection("models");
                        setSettingsOpen(true);
                      }}
                    >
                      {state.config.model}
                      <span aria-hidden="true">⌄</span>
                    </button>
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
                      disabled={!prompt.trim()}
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
                      disabled={busy || fileContent === savedContent}
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
                  readOnly={busy}
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

function ChatMessage({ message }: { message: Message }): React.JSX.Element {
  const user = message.role === "user";
  return (
    <div className={`message ${user ? "user" : "assistant"}`}>
      <div className="avatar">{user ? "Y" : "K"}</div>
      <div className="message-body">
        <div className="message-author">{user ? "You" : "Kairo"}</div>
        <pre className="message-text">{message.content}</pre>
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
