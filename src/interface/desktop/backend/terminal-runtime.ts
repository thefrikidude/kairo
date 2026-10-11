import {
  NativeSessionReader,
  freshNativeCandidates,
  type NativeSessionLookup,
} from "../../../infrastructure/agents/native-session-reader.js";
import { WorkspaceLifecycle } from "./workspace-lifecycle.js";
import type { WorkspaceCreation } from "../../../domain/task-workspace.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import { SqliteTerminalSessionStore } from "../../../infrastructure/persistence/sqlite-terminal-session-store.js";
import { TerminalAgentDiscovery } from "../../../infrastructure/agents/terminal-agent-discovery.js";
import { WorkspaceTerminals } from "../../../infrastructure/terminal/workspace-terminals.js";
import {
  agentDefinition,
  normalizeNativeSession,
  canResumeAgent,
  nativePickerArgs,
} from "../../../infrastructure/agents/terminal-agent-catalog.js";
import { WorkspaceFiles } from "../../../infrastructure/tools/workspace-files.js";
import {
  workspaceReview,
  changedFileReview,
  type ReviewScope,
} from "../../../infrastructure/tools/workspace-review.js";
import type {
  TerminalSession,
  TerminalAgentInfo,
  SessionStartMode,
} from "../../../domain/terminal-agent.js";
import type { WorkspaceSelection } from "../../../domain/task-workspace.js";
import type { TerminalDesktopBootstrap } from "../shared/terminal-api.js";

export type TerminalDesktopRequest = { id: number; method: string; args: unknown[] };
type Emitter = (event: string, payload: unknown) => void;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const overlaps = (a: string, b: string) => {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  return contains(a, b) || contains(b, a);
};

/** CLI terminals replace task/chat protocols. Git/file ownership remains workspace scoped. */
export async function createTerminalDesktopRuntime(
  emitEvent: Emitter,
  options: {
    store?: SqliteTerminalSessionStore;
    agents?: Pick<TerminalAgentDiscovery, "refresh" | "launch">;
    worktrees?: GitWorkspaces;
    terminals?: WorkspaceTerminals;
    nativeReader?: NativeSessionReader;
  } = {},
) {
  const store = options.store ?? (await SqliteTerminalSessionStore.open());
  const agents = options.agents ?? new TerminalAgentDiscovery();
  const nativeReader = options.nativeReader ?? new NativeSessionReader();
  const captures = new Map<
    string,
    { lookup: NativeSessionLookup; baseline: Map<string, number> }
  >();
  const sessionNotices: Record<string, string> = {};
  let capturePromise: Promise<void> | undefined;
  let nativeTimer: ReturnType<typeof setInterval> | undefined;
  const git = options.worktrees ?? new GitWorkspaces();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let catalog: TerminalAgentInfo[] = [];
  const sessionErrors: Record<string, string> = {};
  const starts = new Map<string, Promise<void>>();
  const removing = new Set<string>();
  const mutations = new Set<Promise<unknown>>();
  const pendingTerminalCreates = new Map<string, number>();
  function emit(event: string, payload: unknown): void {
    if (!closed) emitEvent(event, payload);
  }
  const terminals = options.terminals ?? new WorkspaceTerminals(emit);
  const archiving = new Set<string>();
  const lifecycle = new WorkspaceLifecycle(
    store,
    git,
    () => emit("sessions:changed", undefined),
    async (workspaceId, agentId) => {
      if (closed) return;
      const current = store.create(workspaceId, agentId);
      await start(current.id, "fresh");
      if (store.activeWorkspaceId() === workspaceId) store.setActiveSession(current.id);
      emit("sessions:changed", undefined);
    },
  );
  async function refreshWorkspace(id: string): Promise<void> {
    const value = store.workspace(id);
    if (!value || value.removedAt) return;
    try {
      store.reconcileWorkspace(id, await git.describe(value.directory));
      store.updateWorkspace(id, { unavailable: false });
    } catch {
      store.updateWorkspace(id, { unavailable: true });
    }
  }
  function session(id: unknown): TerminalSession {
    if (typeof id !== "string") throw new Error("Choose an agent session.");
    const value = store.get(id);
    if (!value) throw new Error("Session not found.");
    return value;
  }
  function workspace(id: unknown) {
    if (typeof id !== "string") throw new Error("Choose a workspace.");
    const value = store.workspace(id);
    if (!value || value.removedAt) throw new Error("This workspace was removed or is unavailable.");
    if (archiving.has(value.id)) throw new Error("This workspace is being archived.");
    if (removing.has(value.id)) throw new Error("This workspace is being removed.");
    return value;
  }
  function associatedWorkspace(id: unknown) {
    if (typeof id !== "string") throw new Error("Choose a workspace or session.");
    return workspace(store.get(id)?.workspaceId ?? id);
  }
  function snapshot(): TerminalDesktopBootstrap {
    const active = store.activeSessionId();
    const activeSessionId =
      active &&
      store.get(active)?.archivedAt === undefined &&
      store.get(active) &&
      !store.workspace(store.get(active)!.workspaceId)?.archivedAt
        ? active
        : undefined;
    return {
      agents: catalog,
      sessions: store.list(),
      archivedSessions: store.list(true),
      workspaces: store.workspaces(true),
      terminals: terminals.list(),
      activeSessionId,
      activeWorkspaceId: activeSessionId
        ? store.get(activeSessionId)!.workspaceId
        : store.activeWorkspaceId(),
      sessionErrors: { ...sessionErrors },
      sessionNotices: { ...sessionNotices },
      operations: store.operations(),
    };
  }
  async function captureNative(): Promise<void> {
    if (capturePromise) return capturePromise;
    const pending = (async () => {
      for (const [id, entry] of captures) {
        const records = await nativeReader.list(entry.lookup);
        if (captures.get(id) !== entry || !store.get(id)) continue;
        const candidates = freshNativeCandidates(
          records,
          entry.baseline,
          entry.lookup.includeExisting,
        );
        if (candidates.length > 1) {
          const notice =
            "More than one native conversation changed in this workspace. Save an exact Resume ID before reopening.";
          if (sessionNotices[id] !== notice) {
            store.clearNativeSession(id);
            sessionNotices[id] = notice;
            emit("sessions:changed", undefined);
          }
          continue;
        }
        const candidate = candidates[0];
        if (!candidate) continue;
        const previous = store.get(id)!.nativeSession;
        if (previous?.id !== candidate.id || previous.transcriptPath !== candidate.transcriptPath) {
          store.setNativeSession(id, candidate);
          sessionNotices[id] = "Native conversation saved. Reopening resumes this exact session.";
          emit("sessions:changed", undefined);
        }
        entry.baseline.set(candidate.id, candidate.updatedAt);
      }
    })();
    capturePromise = pending;
    try {
      await pending;
    } finally {
      if (capturePromise === pending) capturePromise = undefined;
    }
  }
  async function start(id: string, mode: SessionStartMode = "auto"): Promise<void> {
    const pending = starts.get(id);
    if (pending) return pending;
    const launching = (async () => {
      let current = session(id);
      if (current.archivedAt) throw new Error("Restore this session before opening its terminal.");
      const target = workspace(current.workspaceId);
      if (
        target.archivedAt ||
        target.unavailable ||
        (lifecycle.busy(target.id) &&
          store.operations().some((op) => op.workspaceId === target.id && op.phase !== "ready"))
      )
        throw new Error("Restore this workspace or finish preparation before starting an agent.");
      const existing = terminals.list().find((terminal) => terminal.sessionId === id);
      if (existing?.state === "running") return;
      if (existing) {
        await captureNative();
        await terminals.closeTerminal(existing.id);
        await captureNative();
        current = session(id);
      }
      await git.executionRoot(target.directory);
      try {
        const recovering = mode !== "fresh" && !!current.lastStartedAt;
        const picker =
          mode === "picker" ||
          (recovering && !current.nativeSession && !!nativePickerArgs(current.agentId));
        if (mode === "picker" && !nativePickerArgs(current.agentId))
          throw new Error("Save this agent's exact native session ID to resume it.");
        if (recovering && !current.nativeSession && canResumeAgent(current.agentId) && !picker)
          throw new Error(
            "This agent supports resume, but its native session ID is missing. Save a Resume ID, or choose Start fresh.",
          );
        const launch = await agents.launch(
          current.agentId,
          current.id,
          mode === "fresh" || picker ? undefined : current.nativeSession,
          picker,
          target.directory,
        );
        const since = Date.now();
        const lookup: NativeSessionLookup = {
          agentId: current.agentId,
          directory: target.directory,
          since,
          includeExisting: picker,
          env: launch.env,
        };
        const sharedNativeWorkspace = [
          ...new Set([
            ...terminals
              .list()
              .filter((terminal) => terminal.state === "running")
              .map((terminal) => terminal.sessionId)
              .filter((value): value is string => !!value),
            ...starts.keys(),
          ]),
        ].some((otherId) => {
          const other = store.get(otherId);
          return (
            otherId !== id &&
            other?.agentId === current.agentId &&
            store.workspace(other.workspaceId)?.directory === target.directory
          );
        });
        if (sharedNativeWorkspace) {
          // Cwd metadata cannot identify which of two concurrent CLIs owns a new conversation.
          // Preserve IDs already captured before sharing began, and do not guess new ones.
          for (const [otherId, capture] of captures)
            if (
              capture.lookup.agentId === current.agentId &&
              capture.lookup.directory === target.directory
            )
              captures.delete(otherId);
        }
        if (!sharedNativeWorkspace && nativeReader.supports(current.agentId)) {
          const baseline = new Map(
            (await nativeReader.list(lookup)).map((entry) => [entry.id, entry.updatedAt]),
          );
          captures.set(id, { lookup, baseline });
        }
        if (closed) throw new Error("Kairo is shutting down.");
        await terminals.createAgent(target.id, target.directory, launch);
        if (mode === "fresh" || picker) store.clearNativeSession(id);
        store.markStarted(id, since);
        sessionNotices[id] =
          sharedNativeWorkspace && !current.nativeSession
            ? "Shared workspace: use the CLI’s conversation picker to recover this conversation; automatic identity capture is unavailable while matching agents share a directory."
            : picker
              ? "Choose a conversation in the agent's native resume picker."
              : current.nativeSession && mode !== "fresh"
                ? "Resumed the saved native conversation."
                : !canResumeAgent(current.agentId)
                  ? "This agent starts a fresh conversation each time. Its workspace remains saved."
                  : nativeReader.supports(current.agentId)
                    ? "Waiting for the CLI to save its native session identity…"
                    : "Save the agent's native Resume ID before restarting to continue this conversation.";
        if (closed) throw new Error("Kairo is shutting down.");
        delete sessionErrors[id];
      } catch (error) {
        captures.delete(id);
        sessionErrors[id] = errorText(error);
        throw error;
      }
    })();
    starts.set(id, launching);
    try {
      await launching;
    } finally {
      if (starts.get(id) === launching) starts.delete(id);
    }
  }
  async function stop(id: string): Promise<void> {
    await captureNative();
    const pending = starts.get(id);
    if (pending) await pending.catch(() => {});
    for (const terminal of terminals.list().filter((terminal) => terminal.sessionId === id))
      await terminals.closeTerminal(terminal.id);
    await captureNative();
    captures.delete(id);
  }
  function requireStopped(id: string): void {
    if (starts.has(id) || terminals.list().some((terminal) => terminal.sessionId === id))
      throw new Error("Stop this session's terminal before archiving or deleting it.");
  }
  const ready = (async () => {
    catalog = await agents.refresh();
    await lifecycle.reconcile();
    const pending = [...store.workspaces()];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        let value;
        while ((value = pending.shift())) {
          await refreshWorkspace(value.id);
        }
      }),
    );
    if (!closed) {
      nativeTimer = setInterval(() => {
        void captureNative().catch(() => {});
      }, 1500);
      nativeTimer.unref();
    }
    const active = store.activeSessionId();
    if (
      active &&
      store.get(active) &&
      !store.get(active)!.archivedAt &&
      !store.workspace(store.get(active)!.workspaceId)?.archivedAt
    )
      await start(active).catch((error) => {
        sessionErrors[active] = errorText(error);
      });
  })();
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    terminals.beginClose();
    if (nativeTimer) clearInterval(nativeTimer);
    closePromise = (async () => {
      await ready.catch(() => {});
      await lifecycle.close();
      await Promise.allSettled([...mutations, ...starts.values()]);
      await lifecycle.close();
      try {
        await captureNative();
        await terminals.close();
        await captureNative();
      } finally {
        captures.clear();
        store.close();
      }
    })();
    return closePromise;
  }
  async function handle(request: TerminalDesktopRequest): Promise<unknown> {
    const [first, second, third, fourth] = request.args;
    switch (request.method) {
      case "bootstrap":
        return snapshot();
      case "agents:homepage":
        return agentDefinition(first).homepage;
      case "agents:refresh":
        catalog = await agents.refresh();
        return catalog;
      case "workspace:open": {
        if (typeof first !== "string") throw new Error("Choose a folder.");
        const target = store.registerWorkspace(await git.describe(first));
        store.setActiveSession(undefined);
        store.setActiveWorkspace(target.id);
        return snapshot();
      }
      case "workspace:select": {
        const target = workspace(first);
        if (target.archivedAt) throw new Error("Restore this workspace first.");
        await refreshWorkspace(target.id);
        store.setActiveSession(undefined);
        store.setActiveWorkspace(target.id);
        if (target.lastTab?.startsWith("session:")) {
          const saved = store.get(target.lastTab.slice(8));
          if (saved && !saved.archivedAt) store.setActiveSession(saved.id);
        }
        return snapshot();
      }
      case "workspace:create": {
        const input = first as WorkspaceCreation;
        if (input?.agentId) {
          agentDefinition(input.agentId);
          if (!(await agents.refresh()).find((agent) => agent.id === input.agentId)?.installed)
            throw new Error("Install the selected agent first.");
        }
        await lifecycle.create(input);
        return snapshot();
      }
      case "workspace:preferences":
        if (typeof first !== "string") throw new Error("Choose a project.");
        return lifecycle.preferences(first, second);
      case "workspace:refs": {
        if (typeof first !== "string") throw new Error("Choose a project.");
        const prefs = await lifecycle.preferences(first);
        return git.refs(first, prefs.baseRef, second === true);
      }
      case "workspace:refresh": {
        await refreshWorkspace(workspace(first).id);
        return snapshot();
      }
      case "workspace:rename":
        if (typeof second !== "string") throw new Error("Enter a workspace name.");
        store.updateWorkspace(workspace(first).id, { name: second });
        return snapshot();
      case "workspace:pin":
        if (typeof second !== "boolean") throw new Error("Choose a pin state.");
        store.updateWorkspace(workspace(first).id, { pinned: second });
        return snapshot();
      case "workspace:tab": {
        const target = workspace(first);
        if (
          typeof second !== "string" ||
          !(
            (second.startsWith("session:") &&
              store.get(second.slice(8))?.workspaceId === target.id) ||
            (second.startsWith("terminal:") &&
              terminals.list(target.id).some((t) => t.id === second.slice(9)))
          )
        )
          throw new Error("Choose a tab belonging to this workspace.");
        store.updateWorkspace(target.id, { lastTab: second });
        if (second.startsWith("terminal:")) {
          store.setActiveSession(undefined);
          store.setActiveWorkspace(target.id);
        }
        emit("sessions:changed", undefined);
        return;
      }
      case "workspace:archive": {
        const target = workspace(first);
        if (lifecycle.busy(target.id))
          throw new Error("Cancel or finish preparation before archiving.");
        archiving.add(target.id);
        try {
          for (const current of [...store.list(), ...store.list(true)].filter(
            (s) => s.workspaceId === target.id,
          ))
            await stop(current.id);
          while (pendingTerminalCreates.get(target.id))
            await new Promise((done) => setTimeout(done, 10));
          for (const terminal of terminals.list(target.id))
            await terminals.closeTerminal(terminal.id);
          store.updateWorkspace(target.id, { archivedAt: Date.now() });
          if (store.activeWorkspaceId() === target.id) {
            store.setActiveSession(undefined);
            store.setActiveWorkspace(undefined);
          }
        } finally {
          archiving.delete(target.id);
        }
        return snapshot();
      }
      case "workspace:restore":
        store.updateWorkspace(workspace(first).id, { archivedAt: null });
        await refreshWorkspace(String(first));
        return snapshot();
      case "workspace:cancel":
        if (typeof first !== "string") throw new Error("Choose a preparation.");
        lifecycle.cancel(first);
        return snapshot();
      case "workspace:retry":
        if (typeof first !== "string") throw new Error("Choose a preparation.");
        await lifecycle.retry(first);
        return snapshot();
      case "session:new": {
        agentDefinition(first);
        if (typeof first !== "string" || typeof second !== "string")
          throw new Error("Choose an installed agent and project.");
        if (!(await agents.refresh()).find((agent) => agent.id === first)?.installed)
          throw new Error("Install this agent, then refresh the agent list.");
        const selection = third as WorkspaceSelection | undefined;
        let description;
        if (!selection || selection.kind === "folder") description = await git.describe(second);
        else if (selection.kind === "worktree")
          description = await git.create(second, selection.branch, selection.baseRef);
        else if (selection.kind === "existing")
          description = await git.existing(second, selection.directory);
        else throw new Error("Choose a valid workspace mode.");
        const target = store.registerWorkspace(description);
        if (target.archivedAt || target.unavailable || lifecycle.busy(target.id))
          throw new Error(
            "Restore an available workspace and finish preparation before adding an agent.",
          );
        const current = store.create(target.id, first);
        store.setActiveSession(current.id);
        await start(current.id, "fresh");
        return snapshot();
      }
      case "session:open":
      case "session:start": {
        const current = session(first);
        store.setActiveSession(current.id);
        const mode: SessionStartMode = second === "fresh" || second === "picker" ? second : "auto";
        await start(current.id, mode);
        return snapshot();
      }
      case "session:stop": {
        const current = session(first);
        await stop(current.id);
        return snapshot();
      }
      case "session:native": {
        const current = session(first);
        requireStopped(current.id);
        store.setNativeSession(current.id, normalizeNativeSession(second));
        return snapshot();
      }
      case "session:rename": {
        const current = session(first);
        store.rename(current.id, second);
        return snapshot();
      }
      case "session:archive": {
        const current = session(first);
        await stop(current.id);
        requireStopped(current.id);
        store.archive(current.id);
        if (store.activeSessionId() === current.id) store.setActiveSession(undefined);
        return snapshot();
      }
      case "session:restore": {
        store.restore(session(first).id);
        return snapshot();
      }
      case "session:delete": {
        const current = session(first);
        requireStopped(current.id);
        store.delete(current.id);
        delete sessionErrors[current.id];
        return snapshot();
      }
      case "sessions:delete-archived": {
        for (const current of store.list(true)) requireStopped(current.id);
        for (const current of store.list(true)) store.delete(current.id);
        return snapshot();
      }
      case "worktrees:list": {
        if (typeof first !== "string") throw new Error("Choose a project.");
        return git.list(first);
      }
      case "worktrees:remove": {
        const target = workspace(first);
        if (!target.archivedAt && store.list().some((current) => current.workspaceId === target.id))
          throw new Error("Archive associated sessions before removing this worktree.");
        if (lifecycle.busy(target.id)) throw new Error("Cancel or finish preparation first.");
        removing.add(target.id);
        try {
          if (
            pendingTerminalCreates.get(target.id) ||
            [...starts.keys()].some((id) => store.get(id)?.workspaceId === target.id) ||
            terminals.hasProcesses(target.directory, overlaps)
          )
            throw new Error("Close this workspace's terminals before removing it.");
          await git.remove(target);
          store.markWorkspaceRemoved(target.id);
          return snapshot();
        } finally {
          removing.delete(target.id);
        }
      }
      case "terminal:list":
        return terminals.list(typeof first === "string" ? first : undefined);
      case "terminal:create": {
        const target = workspace(first);
        if (target.archivedAt || target.unavailable)
          throw new Error("Restore an available workspace before opening a terminal.");
        pendingTerminalCreates.set(target.id, (pendingTerminalCreates.get(target.id) ?? 0) + 1);
        try {
          return await terminals.create(target.id, target.directory, second === true);
        } finally {
          pendingTerminalCreates.set(target.id, (pendingTerminalCreates.get(target.id) ?? 1) - 1);
        }
      }
      case "terminal:attach":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        return terminals.attach(first);
      case "terminal:detach":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        terminals.detach(first);
        return;
      case "terminal:ack":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        terminals.acknowledge(first, second);
        return;
      case "terminal:write":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        terminals.input(first, second);
        return;
      case "terminal:resize":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        terminals.resize(first, second, third);
        return;
      case "terminal:close":
        if (typeof first !== "string") throw new Error("Choose a terminal.");
        await terminals.closeTerminal(first);
        return;
      case "workspace:directory":
        return (await WorkspaceFiles.create(associatedWorkspace(first).directory)).directory(
          second,
        );
      case "workspace:snapshot":
        return (await WorkspaceFiles.create(associatedWorkspace(first).directory)).snapshot(second);
      case "workspace:search":
        return (await WorkspaceFiles.create(associatedWorkspace(first).directory)).search(second);
      case "workspace:write":
        return (await WorkspaceFiles.create(associatedWorkspace(first).directory)).save(
          second,
          third,
          fourth,
        );
      case "workspace:review": {
        const target = associatedWorkspace(first);
        const scope = second === "task" ? "task" : "working";
        return workspaceReview(target.directory, scope, target.baseCommit);
      }
      case "workspace:diff": {
        const target = associatedWorkspace(first);
        if (typeof second !== "string") throw new Error("Choose a changed file.");
        const scope: ReviewScope = third === "task" ? "task" : "working";
        return changedFileReview(target.directory, second, scope, target.baseCommit);
      }
      case "workspace:cursor-path": {
        const target = associatedWorkspace(first);
        if (typeof second !== "string") throw new Error("Choose a file.");
        await (await WorkspaceFiles.create(target.directory)).snapshot(second);
        return realpath(resolve(target.directory, second));
      }
      default:
        throw new Error("Unsupported terminal desktop request.");
    }
  }
  async function dispatch(request: TerminalDesktopRequest): Promise<unknown> {
    if (request.method === "shutdown") {
      await close();
      return;
    }
    if (closed) throw new Error("Kairo is shutting down.");
    await ready;
    if (closed) throw new Error("Kairo is shutting down.");
    const pending = handle(request);
    mutations.add(pending);
    try {
      return await pending;
    } finally {
      mutations.delete(pending);
    }
  }
  return { ready, dispatch, close };
}
