import React, { useEffect, useState } from "react";
import type {
  DesktopBootstrap,
  GitWorktree,
  ProjectRefs,
  ProjectPreferences,
  WorkspaceSelection,
} from "../../shared/api.js";
import { ModalFrame } from "./chrome.js";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function WorkspaceDialog({
  initialProject,
  state,
  apply,
  close,
}: {
  initialProject: string;
  state: DesktopBootstrap;
  apply(value: DesktopBootstrap): void;
  close(): void;
}): React.JSX.Element {
  const [project, setProject] = useState(initialProject);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"worktree" | "folder" | "existing">("worktree");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [refs, setRefs] = useState<ProjectRefs>();
  const [trees, setTrees] = useState<GitWorktree[]>([]);
  const [existing, setExisting] = useState("");
  const [agent, setAgent] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let disposed = false;
    setRefs(undefined);
    setTrees([]);
    setError("");
    if (!project) return;
    setLoading(true);
    window.kairo
      .projectRefs(project)
      .then(async (refs) => {
        if (disposed) return;
        const trees = refs.git ? await window.kairo.listWorktrees(project) : [];
        if (disposed) return;
        setRefs(refs);
        setBase(refs.defaultRef);
        setTrees(trees);
        setExisting(trees[0]?.directory ?? "");
        setMode(refs.git ? "worktree" : "folder");
      })
      .catch((error) => {
        if (!disposed) setError(errorText(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [project]);
  const create = async () => {
    setPending(true);
    setError("");
    const selection: WorkspaceSelection =
      mode === "worktree"
        ? { kind: mode, branch, baseRef: base }
        : mode === "existing"
          ? { kind: mode, directory: existing }
          : { kind: mode };
    try {
      apply(
        await window.kairo.createWorkspace({
          project,
          name,
          selection,
          agentId: agent || undefined,
        }),
      );
      close();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <ModalFrame labelledBy="workspace-create-title" blocked={pending} onDismiss={close}>
      <form
        className="new-session-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2 id="workspace-create-title">New workspace</h2>
        <label className="settings-field">
          Project folder
          <div className="folder-picker">
            <input
              aria-label="Workspace project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
            <button
              type="button"
              onClick={() =>
                void window.kairo.pickWorkspace().then((path) => {
                  if (path) setProject(path);
                })
              }
            >
              Browse…
            </button>
          </div>
        </label>
        <label className="settings-field">
          Task name
          <input
            autoFocus
            aria-label="Workspace name"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="settings-field">
          Workspace
          <select
            aria-label="Workspace mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="folder">Project folder (shared)</option>
            {refs?.git && (
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
              Starting branch or commit
              <input
                aria-label="Starting ref"
                list="workspace-refs"
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
              <datalist id="workspace-refs">
                {refs?.refs.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
            </label>
            <p className="empty-small">
              Project default: {refs?.defaultRef || "unavailable"}. Uses committed files.
            </p>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void window.kairo
                  .projectRefs(project, true)
                  .then(setRefs)
                  .catch((e) => setError(errorText(e)))
                  .finally(() => setLoading(false));
              }}
            >
              Refresh remote refs
            </button>
            <label className="settings-field">
              Branch override (optional)
              <input
                aria-label="Branch override"
                value={branch}
                placeholder={`kairo/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "task"}-…`}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
          </>
        )}
        {mode === "existing" && (
          <label className="settings-field">
            Existing worktree
            <select
              aria-label="Existing worktree"
              value={existing}
              onChange={(e) => setExisting(e.target.value)}
            >
              {trees
                .filter((t) => !t.prunable)
                .map((t) => (
                  <option key={t.directory} value={t.directory}>
                    {t.branch ?? "Detached"} · {t.directory}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="settings-field">
          Start an agent after preparation (optional)
          <select
            aria-label="Workspace agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="">No agent</option>
            {state.agents
              .filter((a) => a.installed)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        {error && (
          <p className="file-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={pending} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              pending || loading || !refs || !name.trim() || (mode === "worktree" && !base.trim())
            }
          >
            {pending ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export function ProjectSettings({
  project,
  close,
}: {
  project: string;
  close(): void;
}): React.JSX.Element {
  const [prefs, setPrefs] = useState<ProjectPreferences>();
  const [paths, setPaths] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let disposed = false;
    window.kairo
      .projectPreferences(project)
      .then((value) => {
        if (!disposed) {
          setPrefs(value);
          setPaths(value.copyPaths.join("\n"));
        }
      })
      .catch((e) => {
        if (!disposed) setError(errorText(e));
      });
    return () => {
      disposed = true;
    };
  }, [project]);
  return (
    <ModalFrame labelledBy="project-settings-title" blocked={pending} onDismiss={close}>
      <form
        className="new-session-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!prefs) return;
          setPending(true);
          void window.kairo
            .projectPreferences(project, {
              ...prefs,
              copyPaths: paths
                .split("\n")
                .map((p) => p.trim())
                .filter(Boolean),
            })
            .then(close)
            .catch((e) => setError(errorText(e)))
            .finally(() => setPending(false));
        }}
      >
        <h2 id="project-settings-title">Project setup</h2>
        <p className="empty-small">{project}</p>
        {prefs && (
          <>
            <label className="settings-field">
              Default base ref
              <input
                aria-label="Default base ref"
                placeholder="Detect default branch"
                value={prefs.baseRef ?? ""}
                onChange={(e) => setPrefs({ ...prefs, baseRef: e.target.value })}
              />
            </label>
            <label className="settings-field">
              Setup script
              <textarea
                aria-label="Setup script"
                rows={6}
                placeholder="pnpm install"
                value={prefs.setupScript}
                onChange={(e) => setPrefs({ ...prefs, setupScript: e.target.value })}
              />
            </label>
            <p className="empty-small">
              Runs with sh in each new worktree. KAIRO_SOURCE_DIR and KAIRO_WORKSPACE_DIR identify
              the checkouts. Setup must finish; run servers in a terminal tab.
            </p>
            <label className="settings-field">
              Ignored paths to copy
              <textarea
                aria-label="Copy paths"
                rows={4}
                placeholder={".env\n.env.local"}
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
              />
            </label>
            <p className="empty-small">
              One literal relative path per line. Copies are independent; dependencies are installed
              by the setup script.
            </p>
          </>
        )}
        {error && (
          <p className="file-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button className="primary" disabled={pending || !prefs}>
            Save project setup
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
