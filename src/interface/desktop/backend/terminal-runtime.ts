import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import { SqliteTerminalSessionStore } from "../../../infrastructure/persistence/sqlite-terminal-session-store.js";
import { TerminalAgentDiscovery } from "../../../infrastructure/agents/terminal-agent-discovery.js";
import { WorkspaceTerminals } from "../../../infrastructure/terminal/workspace-terminals.js";
import {
  agentDefinition,
  normalizeNativeSession,
} from "../../../infrastructure/agents/terminal-agent-catalog.js";
import { WorkspaceFiles } from "../../../infrastructure/tools/workspace-files.js";
import {
  workspaceReview,
  changedFileReview,
  type ReviewScope,
} from "../../../infrastructure/tools/workspace-review.js";
import type { TerminalSession, TerminalAgentInfo } from "../../../domain/terminal-agent.js";
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
  } = {},
) {
  const store = options.store ?? (await SqliteTerminalSessionStore.open());
  const agents = options.agents ?? new TerminalAgentDiscovery();
  const git = options.worktrees ?? new GitWorkspaces();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let catalog: TerminalAgentInfo[] = [];
  const sessionErrors: Record<string, string> = {};
  const starts = new Map<string, Promise<void>>();
  const checkoutOwners = new Map<string, string>();
  const rootsByTerminal = new Map<string, { root: string; sessionId: string }>();
  const removing = new Set<string>();
  const mutations = new Set<Promise<unknown>>();
  const pendingTerminalCreates = new Map<string, number>();
  function emit(event: string, payload: unknown): void {
    if (event === "terminal:state") {
      const terminal = payload as { id: string; sessionId?: string; state: string };
      if (terminal.sessionId && terminal.state === "exited") {
        const owner = rootsByTerminal.get(terminal.id);
        if (owner && checkoutOwners.get(owner.root) === terminal.sessionId)
          checkoutOwners.delete(owner.root);
      }
    }
    if (event === "terminal:closed") {
      const owner = rootsByTerminal.get((payload as { id: string }).id);
      if (owner && checkoutOwners.get(owner.root) === owner.sessionId)
        checkoutOwners.delete(owner.root);
      rootsByTerminal.delete((payload as { id: string }).id);
    }
    if (!closed) emitEvent(event, payload);
  }
  const terminals = options.terminals ?? new WorkspaceTerminals(emit);
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
      active && store.get(active)?.archivedAt === undefined && store.get(active)
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
    };
  }
  async function start(id: string): Promise<void> {
    const pending = starts.get(id);
    if (pending) return pending;
    const launching = (async () => {
      const current = session(id);
      if (current.archivedAt) throw new Error("Restore this session before opening its terminal.");
      const target = workspace(current.workspaceId);
      const existing = terminals.list().find((terminal) => terminal.sessionId === id);
      if (existing?.state === "running") return;
      if (existing) await terminals.closeTerminal(existing.id);
      const root = await git.executionRoot(target.directory);
      const owner = checkoutOwners.get(root);
      if (owner && owner !== id)
        throw new Error(
          "Another agent terminal is open in this checkout. Stop it or create an isolated worktree.",
        );
      checkoutOwners.set(root, id);
      try {
        const launch = await agents.launch(current.agentId, current.id, current.nativeSession);
        if (closed) throw new Error("Kairo is shutting down.");
        const terminal = await terminals.createAgent(target.id, target.directory, launch);
        rootsByTerminal.set(terminal.id, { root, sessionId: id });
        delete sessionErrors[id];
      } catch (error) {
        if (checkoutOwners.get(root) === id) checkoutOwners.delete(root);
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
    const pending = starts.get(id);
    if (pending) await pending.catch(() => {});
    for (const terminal of terminals.list().filter((terminal) => terminal.sessionId === id))
      await terminals.closeTerminal(terminal.id);
  }
  function requireStopped(id: string): void {
    if (starts.has(id) || terminals.list().some((terminal) => terminal.sessionId === id))
      throw new Error("Stop this session's terminal before archiving or deleting it.");
  }
  const ready = (async () => {
    catalog = await agents.refresh();
    const pending = [...store.workspaces()];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        let value;
        while ((value = pending.shift())) {
          try {
            store.reconcileWorkspace(value.id, await git.describe(value.directory));
          } catch {
            /* Retain missing-workspace metadata, including branch history. */
          }
        }
      }),
    );
    const active = store.activeSessionId();
    if (active && store.get(active) && !store.get(active)!.archivedAt)
      await start(active).catch((error) => {
        sessionErrors[active] = errorText(error);
      });
  })();
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    terminals.beginClose();
    closePromise = (async () => {
      await ready.catch(() => {});
      await Promise.allSettled([...mutations, ...starts.values()]);
      try {
        await terminals.close();
      } finally {
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
        store.setActiveSession(undefined);
        store.setActiveWorkspace(target.id);
        return snapshot();
      }
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
        const current = store.create(target.id, first);
        store.setActiveSession(current.id);
        await start(current.id);
        return snapshot();
      }
      case "session:open":
      case "session:start": {
        const current = session(first);
        store.setActiveSession(current.id);
        await start(current.id);
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
        if (store.list().some((current) => current.workspaceId === target.id))
          throw new Error("Archive associated sessions before removing this worktree.");
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
