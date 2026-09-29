import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApproval, DesktopBootstrap } from "../../shared/api.js";
import type { ModelSelection, Message } from "../../../../domain/models.js";

type Mode = "build" | "plan";
type Pane = "files" | "changes";
type Theme = "light" | "dark";

export function DesktopApp(): React.JSX.Element {
  const [state, setState] = useState<DesktopBootstrap>();
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [stream, setStream] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("build");
  const [pane, setPane] = useState<Pane>("changes");
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
  const [showSettings, setShowSettings] = useState(false);
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("kairo.theme", theme);
    } catch {
      // The selected theme still applies for this window if storage is unavailable.
    }
  }, [theme]);

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
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state?.messages, stream]);

  const activeSession = state?.sessions.find((item) => item.id === state.activeSessionId);
  const messages = useMemo(
    () =>
      state?.messages.filter(
        (item) => (item.role === "user" || item.role === "model") && !item.toolCallId,
      ) ?? [],
    [state?.messages],
  );

  const openFile = async (path: string) => {
    if (!state?.activeSessionId) return;
    try {
      const content = await window.kairo.readFile(state.activeSessionId, path);
      setSelectedFile(path);
      setShowDiff(false);
      setFileContent(content);
      setSavedContent(content);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const refreshChanges = async () => {
    if (!state?.activeSessionId) return;
    setChanges(await window.kairo.changedFiles(state.activeSessionId));
  };

  const sendTask = async () => {
    if (!state?.activeSessionId || !prompt.trim() || busy) return;
    const text = prompt.trim();
    setPrompt("");
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
      setShowSettings(false);
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

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>Kairo</span>
        </div>
        <button
          className="new-chat"
          onClick={() => void newSession()}
          disabled={!activeSession || busy}
        >
          <span aria-hidden="true">＋</span> New chat
        </button>
        <button
          className="open-project-button"
          onClick={() => void openWorkspace()}
          disabled={busy}
        >
          <span aria-hidden="true">⌕</span> Open project
        </button>
        <div className="section-label">RECENT CHATS</div>
        <div className="session-list">
          {state.sessions.map((session) => (
            <button
              key={session.id}
              className={`session ${session.id === state.activeSessionId ? "selected" : ""}`}
              onClick={() => void openSession(session.id)}
              disabled={busy}
            >
              <span>
                {session.workspace.split("/").filter(Boolean).at(-1) ?? session.workspace}
              </span>
              <small>{new Date(session.updatedAt).toLocaleDateString()}</small>
            </button>
          ))}
        </div>
        <button className="settings-link" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </aside>

      <main className="conversation">
        <header className="topbar">
          <div className="workspace-title">
            <strong>
              {activeSession?.workspace.split("/").filter(Boolean).at(-1) ?? "Choose a project"}
            </strong>
            <span>{activeSession?.workspace ?? "Open a local folder to get started"}</span>
          </div>
          <div className="top-actions">
            <span className="model-pill" title="Current model">
              <span className="status-dot" />
              {state.config.provider} · {state.config.model}
            </span>
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
            <section className="transcript" ref={transcriptRef}>
              {messages.length === 0 && !stream && !state.task && (
                <div className="chat-start">
                  <div className="chat-start-mark">K</div>
                  <p className="eyebrow">YOUR CODING PARTNER</p>
                  <h1>What are we building?</h1>
                  <p className="chat-start-copy">
                    Ask a question, describe a change, or let Kairo explore this codebase.
                  </p>
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
              {busy && !stream && (
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
              <div className="mode-row">
                <button
                  className={mode === "build" ? "mode-active" : ""}
                  onClick={() => setMode("build")}
                >
                  Build
                </button>
                <button
                  className={mode === "plan" ? "mode-active" : ""}
                  onClick={() => setMode("plan")}
                >
                  Plan
                </button>
                <span className="mode-hint">
                  {mode === "build" ? "Make changes" : "Plan first"}
                </span>
              </div>
              <div className="composer">
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendTask();
                    }
                  }}
                  placeholder="Ask Kairo to work on your project…"
                  disabled={busy}
                  rows={3}
                />
                <div className="composer-footer">
                  <span>Enter to send · Shift+Enter for newline</span>
                  {busy ? (
                    <button
                      className="stop-button"
                      onClick={() => void window.kairo.cancel(state.activeSessionId!)}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      onClick={() => void sendTask()}
                      disabled={!prompt.trim()}
                    >
                      Send ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <aside className="workbench">
        <div className="workbench-tabs">
          <button className={pane === "changes" ? "active" : ""} onClick={() => setPane("changes")}>
            Changes <span>{changes.length}</span>
          </button>
          <button className={pane === "files" ? "active" : ""} onClick={() => setPane("files")}>
            Files
          </button>
          <button className="refresh-button" onClick={() => void refreshChanges()} title="Refresh">
            ↻
          </button>
        </div>
        {pane === "changes" ? (
          <div className="file-list">
            {changes.length ? (
              changes.map((path) => (
                <button
                  key={path}
                  className={`file-row ${selectedFile === path ? "selected" : ""}`}
                  onClick={() => void openFile(path)}
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
                    <button
                      onClick={async () => {
                        const result = await window.kairo.diff(
                          state.activeSessionId!,
                          selectedFile,
                        );
                        setDiff(result.diff);
                        setDiffNotice(result.unavailable ?? "");
                        setShowDiff(true);
                      }}
                    >
                      Diff
                    </button>
                  )}
                  {!showDiff && (
                    <button
                      className="save-button"
                      disabled={fileContent === savedContent}
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

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <h2>Settings</h2>
              <button className="icon-button" onClick={() => setShowSettings(false)}>
                ×
              </button>
            </div>
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
            <button className="primary full-width" onClick={() => void chooseModel()}>
              Save model
            </button>
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
