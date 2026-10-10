import type { WorkspaceTerminals } from "../../../infrastructure/terminal/workspace-terminals.js";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import type { WorkspaceSelection } from "../../../domain/task-workspace.js";
import { buildAgentHandoff } from "../../../application/agent-handoff.js";
import type { AgentUsage } from "../../../domain/agent-usage.js";
import { validateAgentAnswers, type AgentAnswers } from "../../../domain/agent-user-input.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalDecision, ApprovalPolicy, JevFeatures } from "../../../domain/ports.js";
import type { ExternalAgentInfo, SessionRuntime } from "../../../domain/agent-runtime.js";
import { AgentRegistry } from "../../../infrastructure/agents/agent-registry.js";
import type { ModelSelection, ToolCall } from "../../../domain/models.js";
import { CodingAgent } from "../../../application/coding-agent.js";
import { executeInteraction, routeInteraction } from "../../../application/interaction-routing.js";
import {
  loadConfig,
  setAutoModelRoutingEnabled,
  setModelSelection,
} from "../../../infrastructure/configuration/config.js";
import {
  SqliteSessionStore,
  type Session,
} from "../../../infrastructure/persistence/sqlite-session-store.js";
import { MacOSKeychainStore } from "../../../infrastructure/security/macos-keychain-store.js";
import { WorkspaceFiles } from "../../../infrastructure/tools/workspace-files.js";
import { WorkspaceTools, definitions } from "../../../infrastructure/tools/workspace-tools.js";
import {
  changedFileReview,
  workspaceReview,
  type ReviewScope,
  changedWorkspaceFiles,
} from "../../../infrastructure/tools/workspace-review.js";
import { RepositoryAwareness } from "../../../infrastructure/repository/repository-awareness.js";
import {
  createProvider,
  providerRegistry,
} from "../../../infrastructure/providers/provider-registry.js";
import { JevDecisionProvider } from "../../../infrastructure/providers/jev-safety-advisor.js";
import type {
  DesktopApproval,
  DesktopBootstrap,
  DesktopUserInput,
  LiveSession,
} from "../shared/api.js";

export type DesktopRequest = { id: number; method: string; args: unknown[] };
export type DesktopEventEmitter = (event: string, payload: unknown) => void;

/** Application boundary for desktop use cases. Transport and Electron stay outside this module. */
export async function createDesktopRuntime(
  emitEvent: DesktopEventEmitter,
  options: {
    store?: SqliteSessionStore;
    terminals?: WorkspaceTerminals;
    agents?: AgentRegistry;
    worktrees?: GitWorkspaces;
    credentials?: Pick<MacOSKeychainStore, "get" | "save">;
  } = {},
) {
  const storePromise = options.store ? Promise.resolve(options.store) : SqliteSessionStore.open();
  const credentials = options.credentials ?? new MacOSKeychainStore();
  const worktrees = options.worktrees ?? new GitWorkspaces();
  let terminals = options.terminals;
  let terminalPromise: Promise<WorkspaceTerminals> | undefined;
  const terminalService = () => {
    if (terminals) return Promise.resolve(terminals);
    return (terminalPromise ??=
      import("../../../infrastructure/terminal/workspace-terminals.js").then(
        ({ WorkspaceTerminals }) => {
          terminals = new WorkspaceTerminals(emit);
          if (closed) terminals.beginClose();
          return terminals;
        },
      ));
  };
  const workspaceRuns = new Map<string, string>();
  const workspaceWrites = new Set<string>();
  const terminalCreates = new Map<string, number>();
  const overlaps = (a: string, b: string) => {
    const contains = (parent: string, child: string) => {
      const rel = relative(parent, child);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    return contains(a, b) || contains(b, a);
  };
  const removingWorkspaces = new Set<string>();
  const removalDirectories = new Map<string, string>();
  const registry = options.agents ?? new AgentRegistry();
  let agentInfo: ExternalAgentInfo[] = [];
  const liveSessions: Record<string, LiveSession> = {};
  const externalControllers = new Map<string, AbortController>();
  const activeRuns = new Set<Promise<void>>();
  const activeRequests = new Set<Promise<unknown>>();
  const sessionRuns = new Map<string, Promise<void>>();
  const switchingSessions = new Set<string>();
  const handoffContinuation = Symbol("handoffContinuation");
  const toolsBySession = new Map<string, WorkspaceTools>();
  const agentsBySession = new Map<string, CodingAgent>();
  const runningSessions = new Set<string>();
  const cancellationRequested = new Set<string>();
  const pendingApprovals = new Map<
    string,
    { sessionId: string; approval: DesktopApproval; resolve(decision: ApprovalDecision): void }
  >();
  const pendingUserInputs = new Map<
    string,
    {
      request: DesktopUserInput;
      resolve(answers?: AgentAnswers): void;
    }
  >();
  function cancelSession(sessionId: string): void {
    if (!runningSessions.has(sessionId)) return;
    cancellationRequested.add(sessionId);
    externalControllers.get(sessionId)?.abort();
    agentsBySession.get(sessionId)?.cancel(sessionId);
    for (const [id, pending] of pendingApprovals) {
      if (pending.sessionId === sessionId) {
        pendingApprovals.delete(id);
        pending.resolve(false);
      }
    }
    for (const pending of pendingUserInputs.values()) {
      if (pending.request.sessionId === sessionId) pending.resolve();
    }
    emit("task:state", { sessionId, state: "cancelling" });
  }
  function resumeAfterInput(sessionId: string): void {
    if (
      liveSessions[sessionId]?.state === "waiting" &&
      !externalControllers.get(sessionId)?.signal.aborted &&
      ![...pendingApprovals.values()].some((item) => item.sessionId === sessionId) &&
      ![...pendingUserInputs.values()].some((item) => item.request.sessionId === sessionId)
    )
      emit("task:state", { sessionId, state: "running", resumed: true });
  }
  let activeSessionId: string | undefined;
  let closed = false;

  const usageCache = new Map<string, AgentUsage>();
  const usageReads = new Map<string, Promise<AgentUsage>>();
  const usageGenerations = new Map<string, number>();
  const usageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let usageRevision = 0;
  function publishUsage(value: Omit<AgentUsage, "revision">): AgentUsage {
    const usage = { ...value, revision: ++usageRevision };
    usageCache.set(usage.agentId, usage);
    emit("agents:usage", usage);
    return usage;
  }
  function readAgentUsage(agentId: string, force = false): Promise<AgentUsage> {
    const pending = usageReads.get(agentId);
    if (pending) return pending;
    const previous = usageCache.get(agentId);
    if (
      !force &&
      previous?.status === "available" &&
      Date.now() - (previous.updatedAt ?? 0) < 60_000
    )
      return Promise.resolve(previous);
    const adapter = registry.get(agentId);
    if (!adapter.readUsage)
      return Promise.resolve(publishUsage({ agentId, status: "unavailable", buckets: [] }));
    const generation = usageGenerations.get(agentId) ?? 0;
    publishUsage({
      ...previous,
      agentId,
      buckets: previous?.buckets ?? [],
      status: "loading",
      error: undefined,
    });
    const read = (async () => {
      try {
        const snapshot = await adapter.readUsage!();
        if (closed || generation !== (usageGenerations.get(agentId) ?? 0))
          return usageCache.get(agentId)!;
        return publishUsage({
          ...snapshot,
          agentId,
          status: snapshot.buckets.some((bucket) => bucket.windows.length)
            ? "available"
            : "unavailable",
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (closed || generation !== (usageGenerations.get(agentId) ?? 0))
          return usageCache.get(agentId)!;
        return publishUsage({
          ...previous,
          agentId,
          buckets: previous?.buckets ?? [],
          status: previous?.updatedAt && previous.buckets.length ? "stale" : "unavailable",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    usageReads.set(agentId, read);
    void read.finally(() => {
      if (usageReads.get(agentId) === read) usageReads.delete(agentId);
    });
    return read;
  }
  const stopUsage = registry.onUsageChanged((agentId, reason) => {
    if (closed || !usageCache.has(agentId)) return;
    if (reason !== "limits") {
      usageGenerations.set(agentId, (usageGenerations.get(agentId) ?? 0) + 1);
      usageReads.delete(agentId);
      publishUsage({
        agentId,
        status: reason === "account" ? "loading" : "unavailable",
        buckets: [],
        error: reason === "disconnected" ? "Agent service disconnected." : undefined,
      });
    }
    clearTimeout(usageTimers.get(agentId));
    if (reason === "disconnected") {
      usageTimers.delete(agentId);
      return;
    }
    usageTimers.set(
      agentId,
      setTimeout(() => {
        usageTimers.delete(agentId);
        // A limits event may arrive while an older read is still in flight.
        void (async () => {
          await usageReads.get(agentId);
          if (!closed) await readAgentUsage(agentId, true);
        })();
      }, 150),
    );
  });

  function requireSession(store: SqliteSessionStore, sessionId: string): Session {
    if (typeof sessionId !== "string") throw new Error("Invalid session id.");
    const session = store.get(sessionId);
    if (!session) throw new Error("Session not found.");
    return session;
  }

  function emit(event: string, payload: unknown): void {
    const value = payload as {
      sessionId?: string;
      state?: LiveSession["state"];
      chunk?: string;
      error?: string;
    };
    const id = value.sessionId;
    if (id) {
      if (
        event === "task:state" &&
        value.state === "running" &&
        !(payload as { resumed?: boolean }).resumed
      )
        liveSessions[id] = { state: "running", startedAt: Date.now(), stream: "", events: [] };
      const live = liveSessions[id];
      if (live) {
        if (event === "task:chunk") live.stream += value.chunk ?? "";
        if (event === "task:state" && value.state) {
          live.state = value.state;
          live.error = value.error;
          if (["complete", "cancelled", "error"].includes(value.state))
            live.finishedAt = Date.now();
        }
        if (event === "approval:request" || event === "user-input:request") live.state = "waiting";
        if (event === "task:event") {
          const item = payload as import("../../../domain/models.js").TaskEvent;
          if (item.kind === "tool_started" || item.kind === "tool_finished") {
            const index = live.events.findIndex((entry) => entry.operationId === item.operationId);
            if (index < 0) live.events.push(item);
            else live.events[index] = item;
          }
        }
      }
    }
    if (!closed) emitEvent(event, payload);
  }

  async function validateRuntime(
    value: unknown,
    requireAuthentication = false,
  ): Promise<SessionRuntime> {
    if (!value || typeof value !== "object") throw new Error("Choose a session runtime.");
    const runtime = value as SessionRuntime;
    if (runtime.kind === "builtin") {
      if (!runtime.selection) return { kind: "builtin" };
      const provider = providerRegistry.find((item) => item.id === runtime.selection?.provider);
      if (
        !provider ||
        typeof runtime.selection.model !== "string" ||
        !runtime.selection.model.trim()
      )
        throw new Error("Choose a supported provider and model.");
      return {
        kind: "builtin",
        selection: { provider: provider.id, model: runtime.selection.model.trim() },
      };
    }
    if (runtime.kind !== "external" || typeof runtime.agentId !== "string")
      throw new Error("Invalid session runtime.");
    const agent = await registry.get(runtime.agentId).inspect();
    if (requireAuthentication && !agent.authenticated)
      throw new Error(`Sign in to ${agent.name} before switching agents.`);
    if (!agent.installed || agent.error)
      throw new Error(agent.error ?? `${agent.name} CLI is not installed.`);
    if (
      runtime.model !== undefined &&
      (typeof runtime.model !== "string" ||
        !agent.models.some((model) => model.id === runtime.model))
    )
      throw new Error("Choose an available agent model.");
    if (
      runtime.codexMode !== undefined &&
      (agent.id !== "codex" || (runtime.codexMode !== "default" && runtime.codexMode !== "plan"))
    )
      throw new Error("Invalid Codex collaboration mode.");
    return {
      kind: "external",
      agentId: agent.id,
      model: runtime.model,
      ...(agent.id === "codex" && runtime.codexMode ? { codexMode: runtime.codexMode } : {}),
    };
  }

  async function toolsFor(store: SqliteSessionStore, sessionId: string): Promise<WorkspaceTools> {
    const session = requireSession(store, sessionId);
    let tools = toolsBySession.get(sessionId);
    if (!tools) {
      tools = await WorkspaceTools.create(session.workspace);
      toolsBySession.set(sessionId, tools);
    }
    return tools;
  }

  async function bootstrap(
    store: SqliteSessionStore,
    sessionId = activeSessionId,
  ): Promise<DesktopBootstrap> {
    const config = await loadConfig();
    const session = sessionId ? requireSession(store, sessionId) : undefined;
    const selection = session?.runtime.kind === "builtin" ? session.runtime.selection : undefined;
    const modelConfig = selection ?? { provider: config.provider, model: config.model };
    const providers = await Promise.all(
      providerRegistry.map(async ({ id, name, environmentVariable, models }) => ({
        id,
        name,
        environmentVariable,
        hasCredential: Boolean(await credentials.get(id)),
        models: models.map(({ id: modelId, label, recommended }) => ({
          id: modelId,
          label,
          recommended,
        })),
      })),
    );
    const task = session ? store.latestTask(session.id) : undefined;
    return {
      agents: agentInfo,
      liveSessions: structuredClone(liveSessions),
      approvals: [...pendingApprovals.values()].map((item) => item.approval),
      userInputs: [...pendingUserInputs.values()].map((item) => item.request),
      sessions: store.list(),
      workspaces: store.workspaces(true),
      archivedSessions: store.listArchived(),
      activeSessionId: session?.id,
      config: modelConfig,
      hasCredential: providers.some(
        (provider) => provider.id === modelConfig.provider && provider.hasCredential,
      ),
      providers,
      messages: session ? store.messages(session.id) : [],
      task,
      taskEvents: task ? store.taskEvents(task.id) : [],
    };
  }

  async function openWorkspace(
    store: SqliteSessionStore,
    requested: string,
  ): Promise<DesktopBootstrap> {
    const description = await worktrees.describe(requested);
    const workspace = description.directory;
    store.registerWorkspace(description);
    const session =
      store.list().find((item) => item.workspace === workspace) ?? store.create(workspace);
    activeSessionId = session.id;
    await new RepositoryAwareness(store).ensureFresh(session.id, workspace);
    return bootstrap(store, session.id);
  }

  class RuntimeApproval implements ApprovalPolicy {
    constructor(private readonly sessionId: string) {}
    approve(call: ToolCall, description: string): Promise<ApprovalDecision> {
      const id = crypto.randomUUID();
      return new Promise((resolveDecision) => {
        const approval: DesktopApproval = {
          id,
          sessionId: this.sessionId,
          toolName: call.name,
          description,
          canAllowFile:
            (call.name === "write_file" || call.name === "edit_file") &&
            typeof call.args.path === "string",
        };
        pendingApprovals.set(id, { sessionId: this.sessionId, approval, resolve: resolveDecision });
        emit("approval:request", approval);
      });
    }
  }

  async function createAgent(
    store: SqliteSessionStore,
    sessionId: string,
    includeRepositoryContext = true,
  ): Promise<CodingAgent> {
    const session = requireSession(store, sessionId);
    const defaults = await loadConfig();
    const config = {
      ...defaults,
      ...(session.runtime.kind === "builtin" ? session.runtime.selection : undefined),
    };
    const apiKey = await credentials.get(config.provider);
    if (!apiKey)
      throw new Error(`No ${config.provider} API key is configured. Add one in Model settings.`);
    const tools = await toolsFor(store, sessionId);
    const repository = new RepositoryAwareness(store);
    if (includeRepositoryContext) await repository.ensureFresh(sessionId, tools.root);
    const jevKey = config.jevEnabled ? await credentials.get("jev") : undefined;
    const features: JevFeatures = {
      routing: config.jevRoutingEnabled,
      safety: config.jevSafetyEnabled,
      recovery: config.jevRecoveryEnabled,
      autonomy: config.jevAutonomyEnabled,
    };
    const agent = new CodingAgent(
      createProvider({ provider: config.provider, model: config.model }, apiKey, definitions),
      store,
      tools,
      new RuntimeApproval(session.id),
      definitions,
      { provider: config.provider, model: config.model },
      jevKey ? new JevDecisionProvider(jevKey) : undefined,
      features,
      repository,
      (event) => emit("task:event", { ...event, sessionId }),
    );
    agentsBySession.set(session.id, agent);
    return agent;
  }

  async function dispatch(request: DesktopRequest): Promise<unknown> {
    const store = await storePromise;
    const [first, second, third] = request.args;
    if (closed && request.method !== "shutdown") throw new Error("Kairo runtime is closed.");
    switch (request.method) {
      case "bootstrap":
        return bootstrap(store);
      case "workspace:open":
        return openWorkspace(store, String(first));
      case "session:open": {
        activeSessionId = requireSession(store, String(first)).id;
        return bootstrap(store, activeSessionId);
      }
      case "session:rename": {
        const session = requireSession(store, String(first));
        store.rename(session.id, second);
        return bootstrap(store);
      }
      case "session:new": {
        const workspace =
          typeof second === "string"
            ? await realpath(second)
            : activeSessionId
              ? requireSession(store, activeSessionId).workspace
              : undefined;
        if (!workspace) throw new Error("Choose a project folder first.");
        const config = await loadConfig();
        const runtime =
          first === undefined
            ? ({
                kind: "builtin",
                selection: { provider: config.provider, model: config.model },
              } as const)
            : await validateRuntime(first);
        const selection = third as WorkspaceSelection | undefined;
        let description;
        if (!selection || selection.kind === "folder")
          description = await worktrees.describe(workspace);
        else if (selection.kind === "worktree") {
          description = await worktrees.create(workspace, selection.branch, selection.baseRef);
        } else if (selection.kind === "existing" && typeof selection.directory === "string") {
          description = await worktrees.existing(workspace, selection.directory);
        } else throw new Error("Choose a folder, new worktree or existing worktree.");
        let owned;
        try {
          owned = store.registerWorkspace(description);
        } catch (error) {
          throw new Error(
            `Could not save workspace ${description.directory}. Its files were preserved. ${(error as Error).message}`,
          );
        }
        if (removingWorkspaces.has(owned.id)) throw new Error("This workspace is being removed.");
        const session = store.create(owned.directory, runtime);
        activeSessionId = session.id;
        await new RepositoryAwareness(store).ensureFresh(session.id, session.workspace);
        return bootstrap(store, session.id);
      }
      case "terminal:list":
        return terminals?.list(typeof first === "string" ? first : undefined) ?? [];
      case "terminal:create": {
        const workspace = store.workspace(String(first));
        if (!workspace || workspace.removedAt) throw new Error("This workspace is unavailable.");
        const directory = await realpath(workspace.directory);
        const service = await terminalService();
        if (closed) throw new Error("Kairo is shutting down.");
        if (
          removingWorkspaces.has(workspace.id) ||
          [...removalDirectories.values()].some((removing) => overlaps(directory, removing))
        )
          throw new Error("This workspace is being removed.");
        terminalCreates.set(directory, (terminalCreates.get(directory) ?? 0) + 1);
        try {
          return await service.create(workspace.id, directory, second === true);
        } finally {
          const remaining = (terminalCreates.get(directory) ?? 1) - 1;
          if (remaining) terminalCreates.set(directory, remaining);
          else terminalCreates.delete(directory);
        }
      }
      case "terminal:attach":
        return (await terminalService()).attach(String(first));
      case "terminal:detach":
        terminals?.detach(String(first));
        return undefined;
      case "terminal:ack":
        terminals?.acknowledge(String(first), second);
        return undefined;
      case "terminal:write":
        (await terminalService()).input(String(first), second);
        return undefined;
      case "terminal:resize":
        (await terminalService()).resize(String(first), second, third);
        return undefined;
      case "terminal:close":
        await (await terminalService()).closeTerminal(String(first));
        return undefined;
      case "worktrees:list": {
        if (typeof first !== "string") throw new Error("Choose a project.");
        const project = await worktrees.describe(first);
        return project.kind === "folder" ? [] : worktrees.list(project.repositoryPath);
      }
      case "worktrees:remove": {
        const workspace = store.workspace(String(first));
        if (!workspace || workspace.removedAt) throw new Error("Workspace not found.");
        if (removingWorkspaces.has(workspace.id))
          throw new Error("This workspace is already being removed.");
        const directory = await realpath(workspace.directory);
        const associated = [...store.list(), ...store.listArchived()].filter((session) =>
          overlaps(session.workspace, directory),
        );
        if (
          associated.some(
            (session) => runningSessions.has(session.id) || switchingSessions.has(session.id),
          )
        )
          throw new Error("Stop all agents in this workspace before removing it.");
        if (associated.some((session) => !session.archivedAt))
          throw new Error(
            "Archive all chats in this workspace before removing it. Their history will be kept.",
          );
        if (removingWorkspaces.has(workspace.id))
          throw new Error("This workspace is already being removed.");
        if ([...workspaceWrites].some((savingDirectory) => overlaps(directory, savingDirectory)))
          throw new Error("Wait for file saves to finish before removing this worktree.");
        if (
          [...terminalCreates.keys()].some((creatingDirectory) =>
            overlaps(directory, creatingDirectory),
          )
        )
          throw new Error("Wait for terminals to open before removing this workspace.");
        if (terminals?.hasProcesses(directory, overlaps))
          throw new Error("Close all terminals in this workspace before removing it.");
        removingWorkspaces.add(workspace.id);
        removalDirectories.set(workspace.id, directory);
        try {
          await worktrees.remove(workspace);
          store.markWorkspaceRemoved(workspace.id);
        } finally {
          removingWorkspaces.delete(workspace.id);
          removalDirectories.delete(workspace.id);
        }
        return bootstrap(store);
      }
      case "agents:usage": {
        const session = requireSession(store, String(first));
        if (session.runtime.kind === "builtin")
          return {
            agentId: session.runtime.selection?.provider ?? "kairo",
            revision: 0,
            status: "unavailable",
            buckets: [],
          } satisfies AgentUsage;
        return readAgentUsage(session.runtime.agentId, second === true);
      }
      case "agents:refresh":
        agentInfo = await registry.inspect();
        return agentInfo;
      case "agents:login":
        return registry.get(String(first)).login();
      case "session:runtime": {
        const session = requireSession(store, String(first));
        if (switchingSessions.has(session.id))
          throw new Error("An agent switch is already in progress.");
        switchingSessions.add(session.id);
        try {
          // Validate the destination before interrupting any useful work.
          let runtime = await validateRuntime(second, true);
          const identity = (value: SessionRuntime) =>
            value.kind === "builtin" ? "builtin" : value.agentId;
          const changed = identity(runtime) !== identity(session.runtime);
          const continueTask = changed && runningSessions.has(session.id);
          if (continueTask && runtime.kind === "builtin") {
            const config = runtime.selection ?? (await loadConfig());
            if (!(await credentials.get(config.provider)))
              throw new Error(
                "Add a Kairo provider API key before switching an active task to Kairo.",
              );
          }
          if (runningSessions.has(session.id)) {
            if (!changed) throw new Error("Stop this session before changing its model.");
            cancelSession(session.id);
            await sessionRuns.get(session.id);
          }
          if (closed) throw new Error("Kairo runtime is closed.");
          if (
            runtime.kind === "external" &&
            runtime.agentId === "codex" &&
            session.runtime.kind === "external" &&
            session.runtime.agentId === "codex" &&
            runtime.codexMode === undefined
          )
            runtime = { ...runtime, codexMode: session.runtime.codexMode };
          if (changed && (store.messageCount(session.id) || session.externalSessionId)) {
            const label = (value: SessionRuntime) =>
              value.kind === "builtin" ? "Kairo" : registry.get(value.agentId).name;
            store.switchSessionRuntime(
              session.id,
              runtime,
              label(session.runtime),
              label(runtime),
              buildAgentHandoff(store, session.id, session.workspace),
            );
          } else store.setSessionRuntime(session.id, runtime);
          if (continueTask) {
            const task = store.latestTask(session.id);
            if (task)
              await dispatch({
                id: request.id,
                method: "task:send",
                args: [
                  session.id,
                  `Resume the interrupted task: ${task.prompt}`,
                  task.mode === "planning" ||
                  (session.runtime.kind === "external" && session.runtime.codexMode === "plan")
                    ? "plan"
                    : "build",
                  task.mode === "planning" ||
                  (session.runtime.kind === "external" && session.runtime.codexMode === "plan")
                    ? "plan"
                    : undefined,
                  handoffContinuation,
                ],
              });
          }
          return bootstrap(store, session.id);
        } finally {
          switchingSessions.delete(session.id);
        }
      }
      case "session:archive":
      case "session:delete": {
        const sessionId = String(first);
        requireSession(store, sessionId);
        if (runningSessions.has(sessionId) || switchingSessions.has(sessionId))
          throw new Error("Stop the running task before changing this chat.");
        if (request.method === "session:archive") store.archive(sessionId);
        else store.delete(sessionId);
        delete liveSessions[sessionId];
        if (activeSessionId === sessionId) activeSessionId = store.list()[0]?.id;
        return bootstrap(store, activeSessionId);
      }
      case "sessions:delete-archived": {
        const archivedSessions = store.listArchived();
        if (
          archivedSessions.some(
            (session) => runningSessions.has(session.id) || switchingSessions.has(session.id),
          )
        )
          throw new Error("Stop every running task before deleting archived chats.");
        const removedIds = store.deleteArchived();
        for (const sessionId of removedIds) {
          delete liveSessions[sessionId];
          toolsBySession.delete(sessionId);
          agentsBySession.delete(sessionId);
          externalControllers.delete(sessionId);
        }
        for (const [id, item] of pendingApprovals) {
          if (removedIds.includes(item.approval.sessionId)) pendingApprovals.delete(id);
        }
        if (activeSessionId && removedIds.includes(activeSessionId))
          activeSessionId = store.list()[0]?.id;
        return bootstrap(store, activeSessionId);
      }
      case "project:archive": {
        if (typeof first !== "string" || !first) throw new Error("Choose a project to archive.");
        const projectSessions = store
          .list()
          .filter(
            (session) =>
              store.workspace(session.workspaceId)?.repositoryPath === first ||
              session.workspace === first,
          );
        if (!projectSessions.length) throw new Error("Project has no active chats to archive.");
        if (
          projectSessions.some(
            (session) => runningSessions.has(session.id) || switchingSessions.has(session.id),
          )
        )
          throw new Error("Stop every running chat in this project before archiving it.");
        const archivedIds = store.archiveWorkspace(first);
        for (const sessionId of archivedIds) delete liveSessions[sessionId];
        if (activeSessionId && archivedIds.includes(activeSessionId))
          activeSessionId = store.list()[0]?.id;
        return bootstrap(store, activeSessionId);
      }
      case "project:delete": {
        if (typeof first !== "string" || !first) throw new Error("Choose a project to delete.");
        const projectSessions = [...store.list(), ...store.listArchived()].filter(
          (session) =>
            store.workspace(session.workspaceId)?.repositoryPath === first ||
            session.workspace === first,
        );
        if (!projectSessions.length) throw new Error("Project not found.");
        if (
          projectSessions.some(
            (session) => runningSessions.has(session.id) || switchingSessions.has(session.id),
          )
        )
          throw new Error("Stop every running chat in this project before deleting it.");
        const removedIds = store.deleteWorkspace(first);
        for (const sessionId of removedIds) {
          delete liveSessions[sessionId];
          toolsBySession.delete(sessionId);
          agentsBySession.delete(sessionId);
          externalControllers.delete(sessionId);
        }
        for (const [id, item] of pendingApprovals) {
          if (removedIds.includes(item.approval.sessionId)) pendingApprovals.delete(id);
        }
        if (activeSessionId && removedIds.includes(activeSessionId))
          activeSessionId = store.list()[0]?.id;
        return bootstrap(store, activeSessionId);
      }
      case "session:restore": {
        const session = requireSession(store, String(first));
        if (store.workspace(session.workspaceId)?.removedAt)
          throw new Error("This chat's worktree was removed. Its history is kept in the archive.");
        store.restore(session.id);
        return bootstrap(store, activeSessionId);
      }
      case "task:send": {
        const session = requireSession(store, String(first));
        const prompt = second;
        const mode = third;
        const requestedCodexMode = request.args[3];
        if (switchingSessions.has(session.id) && request.args[4] !== handoffContinuation)
          throw new Error("Wait for the agent switch to finish.");
        if (runningSessions.has(session.id))
          throw new Error("A task is already running in this session.");
        if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Enter a task first.");
        if (mode !== "build" && mode !== "plan") throw new Error("Invalid task mode.");
        const owned = store.workspace(session.workspaceId);
        if (!owned || owned.removedAt || removingWorkspaces.has(owned.id))
          throw new Error(
            "This workspace is unavailable. Choose another workspace for a new session.",
          );
        const runDirectory = await realpath(owned.directory);
        if (closed) throw new Error("Kairo is shutting down.");
        if (
          store.workspace(session.workspaceId)?.removedAt ||
          removingWorkspaces.has(session.workspaceId)
        )
          throw new Error("This workspace is unavailable.");
        if (store.get(session.id)?.archivedAt)
          throw new Error("Restore this chat before starting another task.");
        if (runningSessions.has(session.id))
          throw new Error("A task is already running in this session.");
        if ([...removalDirectories.values()].some((directory) => overlaps(directory, runDirectory)))
          throw new Error("This workspace is being removed.");
        if ([...workspaceWrites].some((directory) => overlaps(directory, runDirectory)))
          throw new Error("A file is being saved in this workspace. Try again in a moment.");
        const owner = [...workspaceRuns].find(([directory]) =>
          overlaps(directory, runDirectory),
        )?.[1];
        if (owner && owner !== session.id)
          throw new Error(
            "Another agent is working in this folder. Create an isolated worktree or wait for that task to finish.",
          );
        workspaceRuns.set(runDirectory, session.id);
        runningSessions.add(session.id);
        emit("task:state", { sessionId: session.id, state: "running" });
        const controller = new AbortController();
        externalControllers.set(session.id, controller);
        const runPromise = (async () => {
          let state: "complete" | "error" | "cancelled" = "complete";
          let errorMessage: string | undefined;
          try {
            if (session.runtime.kind === "builtin" && !session.runtime.selection) {
              const config = await loadConfig();
              session.runtime = {
                kind: "builtin",
                selection: { provider: config.provider, model: config.model },
              };
              store.setSessionRuntime(session.id, session.runtime);
            }
            if (session.runtime.kind === "external") {
              const adapter = registry.get(session.runtime.agentId);
              const externalMode = session.runtime.agentId === "codex" ? "build" : mode;
              const codexMode =
                session.runtime.agentId === "codex"
                  ? (session.runtime.codexMode ??
                    (requestedCodexMode === "plan" || requestedCodexMode === "default"
                      ? requestedCodexMode
                      : undefined))
                  : undefined;
              if (session.runtime.agentId === "codex" && session.runtime.codexMode !== codexMode) {
                session.runtime = { ...session.runtime, codexMode };
                store.setSessionRuntime(session.id, session.runtime);
              }
              const savedHandoff = store.latestAgentHandoff(session.id);
              const context =
                !session.externalSessionId && savedHandoff?.startsWith("Kairo task handoff")
                  ? savedHandoff
                  : store.latestTask(session.id) ||
                      store.messages(session.id).some((message) => message.role === "user")
                    ? buildAgentHandoff(store, session.id, session.workspace)
                    : undefined;
              const task = store.startTask(
                session.id,
                prompt,
                externalMode === "plan" ? "planning" : "implementation",
              );
              store.addMessage(session.id, {
                role: "user",
                content: prompt,
                createdAt: Date.now(),
              });
              store.updateTask(task.id, { status: "acting" });
              let text = "";
              try {
                state = await adapter.run({
                  workspace: session.workspace,
                  threadId: session.externalSessionId,
                  model: session.runtime.model,
                  prompt,
                  context,
                  codexMode,
                  // Codex owns its collaboration mode. Never route it through Kairo's
                  // built-in planning/read-only workflow.
                  mode: externalMode,
                  signal: controller.signal,
                  onThread: (id) => store.setExternalSessionId(session.id, id),
                  onText: (chunk) => {
                    text += chunk;
                    emit("task:chunk", { sessionId: session.id, chunk });
                  },
                  onTool: (id, name, complete, outcome, paths) => {
                    const navigationPaths = paths?.slice(0, 20).flatMap((path) => {
                      if (typeof path !== "string" || path.length > 1_000 || path.includes("\0"))
                        return [];
                      const local = relative(session.workspace, resolve(session.workspace, path));
                      return local &&
                        local !== ".." &&
                        !local.startsWith(`..${sep}`) &&
                        !isAbsolute(local)
                        ? [local.split(sep).join("/")]
                        : [];
                    });
                    const event = {
                      taskId: task.id,
                      operationId: id,
                      name,
                      paths: navigationPaths ? [...new Set(navigationPaths)] : undefined,
                      kind: complete ? ("tool_finished" as const) : ("tool_started" as const),
                      outcome,
                      createdAt: Date.now(),
                    };
                    store.recordTaskEvent(event);
                    emit("task:event", { ...event, sessionId: session.id });
                  },
                  requestUserInput: (questions, signal) => {
                    if (signal.aborted || closed) return Promise.resolve(undefined);
                    const request: DesktopUserInput = {
                      id: crypto.randomUUID(),
                      sessionId: session.id,
                      questions,
                    };
                    return new Promise<AgentAnswers | undefined>((resolveAnswers) => {
                      const settle = (answers?: AgentAnswers) => {
                        if (!pendingUserInputs.delete(request.id)) return;
                        signal.removeEventListener("abort", abort);
                        emit("user-input:resolved", { id: request.id, sessionId: session.id });
                        resolveAnswers(answers);
                        if (!signal.aborted) resumeAfterInput(session.id);
                      };
                      const abort = () => settle();
                      pendingUserInputs.set(request.id, { request, resolve: settle });
                      signal.addEventListener("abort", abort, { once: true });
                      emit("user-input:request", request);
                    });
                  },
                  approve: async (name, description) => {
                    if (controller.signal.aborted || closed) return false;
                    const decision = await new RuntimeApproval(session.id).approve(
                      { id: crypto.randomUUID(), name, args: {} },
                      description,
                    );
                    return decision === true;
                  },
                });
                const ownedWorkspace = store.workspace(session.workspaceId);
                const changes = await workspaceReview(
                  session.workspace,
                  ownedWorkspace?.baseCommit ? "task" : "working",
                  ownedWorkspace?.baseCommit,
                )
                  .then((review) => review.changes.map((change) => change.path))
                  .catch(() => changedWorkspaceFiles(session.workspace));
                store.updateTask(task.id, {
                  status:
                    state === "cancelled"
                      ? "cancelled"
                      : externalMode === "plan"
                        ? "planned"
                        : changes.length
                          ? "verification_required"
                          : "completed",
                  changedFiles: changes,
                  summary: text,
                });
              } catch (error) {
                store.updateTask(task.id, {
                  status: controller.signal.aborted ? "cancelled" : "failed",
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              } finally {
                if (text)
                  store.addMessage(session.id, {
                    role: "model",
                    agentName: adapter.name,
                    content: text,
                    createdAt: Date.now(),
                  });
              }
              return;
            }
            const defaults = await loadConfig();
            const config = { ...defaults, ...session.runtime.selection };
            const jevKey =
              config.jevEnabled && config.jevRoutingEnabled
                ? await credentials.get("jev")
                : undefined;
            const interaction = await routeInteraction(
              prompt,
              mode,
              config.autoModelRoutingEnabled,
              jevKey ? new JevDecisionProvider(jevKey) : undefined,
            );
            if (cancellationRequested.delete(session.id) || controller.signal.aborted) {
              state = "cancelled";
              return;
            }
            const agent = interaction.localResponse
              ? undefined
              : await createAgent(store, session.id, interaction.mode !== "answer");
            const onText = (chunk: string) => emit("task:chunk", { sessionId: session.id, chunk });
            const run = executeInteraction(interaction, session.id, prompt, store, agent, onText);
            if (cancellationRequested.delete(session.id)) agent?.cancel(session.id);
            await run;
            if (agent?.status(session.id)?.status === "cancelled") state = "cancelled";
          } catch (error) {
            state =
              controller.signal.aborted || cancellationRequested.has(session.id)
                ? "cancelled"
                : "error";
            errorMessage = error instanceof Error ? error.message : String(error);
          } finally {
            for (const pending of pendingUserInputs.values()) {
              if (pending.request.sessionId === session.id) pending.resolve();
            }
            for (const [id, pending] of pendingApprovals) {
              if (pending.sessionId === session.id) {
                pendingApprovals.delete(id);
                pending.resolve(false);
              }
            }
            externalControllers.delete(session.id);
            runningSessions.delete(session.id);
            if (workspaceRuns.get(runDirectory) === session.id) workspaceRuns.delete(runDirectory);
            cancellationRequested.delete(session.id);
            agentsBySession.delete(session.id);
            emit("task:state", {
              sessionId: session.id,
              state,
              task: store.latestTask(session.id),
              error: errorMessage,
            });
          }
        })();
        activeRuns.add(runPromise);
        sessionRuns.set(session.id, runPromise);
        void runPromise.finally(() => {
          activeRuns.delete(runPromise);
          sessionRuns.delete(session.id);
        });
        return undefined;
      }
      case "codex:command": {
        const session = requireSession(store, String(first));
        const command = second;
        const argument = third;
        if (runningSessions.has(session.id) || switchingSessions.has(session.id))
          throw new Error("Wait for the Codex turn to finish before running a command.");
        if (session.runtime.kind !== "external" || session.runtime.agentId !== "codex")
          throw new Error("Codex commands are available in Codex sessions only.");
        if (
          command !== "plan" &&
          command !== "default" &&
          command !== "model" &&
          command !== "compact"
        )
          throw new Error(`Unsupported Codex command: /${String(command)}.`);
        if (command === "model" && (typeof argument !== "string" || !argument.trim()))
          throw new Error("Choose a model with /model <model>.");
        if (command === "compact" && !session.externalSessionId)
          throw new Error("Send a Codex message before using /compact.");
        const adapter = registry.get(session.runtime.agentId);
        if (!adapter.executeCommand)
          throw new Error("This Codex adapter does not support commands.");
        const result = await adapter.executeCommand({
          threadId: session.externalSessionId,
          workspace: session.workspace,
          command,
          argument: typeof argument === "string" ? argument : undefined,
          model: session.runtime.model,
        });
        if (command === "model" && typeof argument === "string") {
          session.runtime = { ...session.runtime, model: argument.trim() };
          store.setSessionRuntime(session.id, session.runtime);
        } else if (command === "plan" || command === "default") {
          session.runtime = {
            ...session.runtime,
            codexMode: command === "plan" ? "plan" : "default",
          };
          store.setSessionRuntime(session.id, session.runtime);
        }
        store.addMessage(session.id, { role: "model", content: result, createdAt: Date.now() });
        return result;
      }
      case "task:cancel": {
        const session = requireSession(store, String(first));
        cancelSession(session.id);
        return undefined;
      }
      case "workspace:list": {
        const result = await (
          await toolsFor(store, String(first))
        ).execute({ id: crypto.randomUUID(), name: "list_files", args: {} });
        if (!result.ok) throw new Error(result.output);
        return result.output === "No files found." ? [] : result.output.split("\n");
      }
      case "workspace:directory": {
        const files = await WorkspaceFiles.create(requireSession(store, String(first)).workspace);
        return files.directory(second ?? ".");
      }
      case "workspace:read": {
        const files = await WorkspaceFiles.create(requireSession(store, String(first)).workspace);
        return files.read(second);
      }
      case "workspace:snapshot": {
        const files = await WorkspaceFiles.create(requireSession(store, String(first)).workspace);
        return files.snapshot(second);
      }
      case "workspace:search": {
        const files = await WorkspaceFiles.create(requireSession(store, String(first)).workspace);
        return files.search(second);
      }
      case "workspace:write": {
        const session = requireSession(store, String(first));
        const directory = await realpath(session.workspace);
        if (
          [...workspaceRuns.keys()].some((runningDirectory) =>
            overlaps(directory, runningDirectory),
          )
        )
          throw new Error("Stop agents working in this workspace before saving files.");
        if ([...workspaceWrites].some((savingDirectory) => overlaps(directory, savingDirectory)))
          throw new Error("Another file save is in progress. Try again in a moment.");
        if (
          [...removalDirectories.values()].some((removingDirectory) =>
            overlaps(directory, removingDirectory),
          )
        )
          throw new Error("This workspace is being removed.");
        if (closed) throw new Error("Kairo is shutting down.");
        workspaceWrites.add(directory);
        try {
          return await (
            await WorkspaceFiles.create(directory)
          ).save(second, third, request.args[3]);
        } finally {
          workspaceWrites.delete(directory);
        }
      }
      case "workspace:review": {
        const session = requireSession(store, String(first));
        const workspace = store.workspace(session.workspaceId);
        const scope = second === "task" && workspace?.baseCommit ? "task" : "working";
        return workspaceReview(session.workspace, scope, workspace?.baseCommit);
      }
      case "workspace:changes":
        return changedWorkspaceFiles(requireSession(store, String(first)).workspace);
      case "workspace:diff": {
        const session = requireSession(store, String(first));
        const workspace = store.workspace(session.workspaceId);
        const scope: ReviewScope = third === "task" && workspace?.baseCommit ? "task" : "working";
        const review = await changedFileReview(
          session.workspace,
          String(second),
          scope,
          workspace?.baseCommit,
        );
        return { diff: review.diff, unavailable: review.unavailable };
      }
      case "workspace:cursor-path": {
        const session = requireSession(store, String(first));
        if (typeof second !== "string" || !second.trim())
          throw new Error("Choose a changed file to open in Cursor.");
        const absolutePath = await (
          await WorkspaceFiles.create(session.workspace)
        ).resolveFile(second);
        const workspaceRelative = relative(session.workspace, absolutePath);
        if (
          !workspaceRelative ||
          workspaceRelative === ".." ||
          workspaceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        )
          throw new Error("This path is outside the active workspace.");
        return absolutePath;
      }
      case "model:save": {
        const targetSessionId = activeSessionId;
        if (
          targetSessionId &&
          (runningSessions.has(targetSessionId) || switchingSessions.has(targetSessionId))
        )
          throw new Error("Stop this session before changing its model.");
        const selection = first as ModelSelection;
        const apiKey = typeof second === "string" ? second.trim() : "";
        const provider = providerRegistry.find((item) => item.id === selection?.provider);
        if (!provider || typeof selection.model !== "string" || !selection.model.trim())
          throw new Error("Choose a supported provider and model.");
        if (apiKey) {
          await provider.validate(apiKey);
          await credentials.save(provider.id, apiKey);
        } else if (!(await credentials.get(provider.id))) {
          throw new Error(`Add an API key for ${provider.name}.`);
        }
        if (
          targetSessionId &&
          (runningSessions.has(targetSessionId) || switchingSessions.has(targetSessionId))
        )
          throw new Error("Stop this session before changing its model.");
        await setModelSelection({ provider: provider.id, model: selection.model.trim() });
        await setAutoModelRoutingEnabled(false);
        if (targetSessionId) {
          const session = requireSession(store, targetSessionId);
          if (session.runtime.kind === "builtin") {
            if (runningSessions.has(session.id))
              throw new Error("Stop this session before changing its model.");
            store.setSessionRuntime(session.id, {
              kind: "builtin",
              selection: { provider: provider.id, model: selection.model.trim() },
            });
          }
        }
        return bootstrap(store);
      }
      case "user-input:resolve": {
        const pending = pendingUserInputs.get(String(first));
        if (!pending) throw new Error("This Codex question is no longer active.");
        pending.resolve(validateAgentAnswers(pending.request.questions, second));
        return undefined;
      }
      case "approval:resolve": {
        const id = String(first);
        const decision = second;
        const pending = pendingApprovals.get(id);
        if (!pending) return undefined;
        if (!["approve", "task_file", "deny"].includes(String(decision)))
          throw new Error("Invalid approval decision.");
        pendingApprovals.delete(id);
        pending.resolve(
          decision === "deny"
            ? false
            : decision === "task_file" && pending.approval.canAllowFile
              ? "task_file"
              : true,
        );
        resumeAfterInput(pending.sessionId);
        return undefined;
      }
      case "shutdown":
        await close();
        return undefined;
      default:
        throw new Error(`Unknown desktop runtime method: ${request.method}`);
    }
  }

  function dispatchRequest(request: DesktopRequest): Promise<unknown> {
    if (closed && request.method !== "shutdown")
      return Promise.reject(new Error("Kairo is shutting down."));
    const pending = dispatch(request);
    if (request.method !== "shutdown") {
      activeRequests.add(pending);
      void pending.finally(() => activeRequests.delete(pending)).catch(() => {});
    }
    return pending;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    terminals?.beginClose();
    stopUsage();
    for (const timer of usageTimers.values()) clearTimeout(timer);
    usageTimers.clear();
    for (const pending of pendingApprovals.values()) pending.resolve(false);
    pendingApprovals.clear();
    for (const pending of pendingUserInputs.values()) pending.resolve();
    for (const sessionId of runningSessions) cancellationRequested.add(sessionId);
    for (const controller of externalControllers.values()) controller.abort();
    for (const [sessionId, agent] of agentsBySession) agent.cancel(sessionId);
    await registry.close();
    await Promise.allSettled([...activeRuns]);
    await Promise.allSettled([...activeRequests]);
    await terminals?.close();
    (await storePromise).close();
  }

  return {
    ready: storePromise.then(async (store) => {
      for (const workspace of store.workspaces()) {
        try {
          store.reconcileWorkspace(workspace.id, await worktrees.describe(workspace.directory));
        } catch {
          /* A missing folder must not destroy persisted chat history. */
        }
      }
      activeSessionId = store.list()[0]?.id;
    }),
    dispatch: dispatchRequest,
    close,
  };
}
