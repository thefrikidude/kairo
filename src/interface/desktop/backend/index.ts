import { realpath } from "node:fs/promises";
import type { ApprovalDecision, ApprovalPolicy, JevFeatures } from "../../../domain/ports.js";
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
import { WorkspaceTools, definitions } from "../../../infrastructure/tools/workspace-tools.js";
import {
  changedFileReview,
  changedWorkspaceFiles,
} from "../../../infrastructure/tools/workspace-review.js";
import { RepositoryAwareness } from "../../../infrastructure/repository/repository-awareness.js";
import {
  createProvider,
  providerRegistry,
} from "../../../infrastructure/providers/provider-registry.js";
import { JevDecisionProvider } from "../../../infrastructure/providers/jev-safety-advisor.js";
import type { DesktopApproval, DesktopBootstrap } from "../shared/api.js";

export type DesktopRequest = { id: number; method: string; args: unknown[] };
export type DesktopEventEmitter = (event: string, payload: unknown) => void;

/** Application boundary for desktop use cases. Transport and Electron stay outside this module. */
export async function createDesktopRuntime(emit: DesktopEventEmitter) {
  const storePromise = SqliteSessionStore.open();
  const credentials = new MacOSKeychainStore();
  const toolsBySession = new Map<string, WorkspaceTools>();
  const agentsBySession = new Map<string, CodingAgent>();
  const runningSessions = new Set<string>();
  const cancellationRequested = new Set<string>();
  const pendingApprovals = new Map<
    string,
    { sessionId: string; resolve(decision: ApprovalDecision): void }
  >();
  let activeSessionId: string | undefined;
  let closed = false;

  function requireSession(store: SqliteSessionStore, sessionId: string): Session {
    if (typeof sessionId !== "string") throw new Error("Invalid session id.");
    const session = store.get(sessionId);
    if (!session) throw new Error("Session not found.");
    return session;
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
    return {
      sessions: store.list(),
      archivedSessions: store.listArchived(),
      activeSessionId: session?.id,
      config: { provider: config.provider, model: config.model },
      hasCredential: Boolean(await credentials.get(config.provider)),
      providers: providerRegistry.map(({ id, name, environmentVariable, models }) => ({
        id,
        name,
        environmentVariable,
        models: models.map(({ id: modelId, label, recommended }) => ({
          id: modelId,
          label,
          recommended,
        })),
      })),
      messages: session ? store.messages(session.id) : [],
      task: session ? store.latestTask(session.id) : undefined,
    };
  }

  async function openWorkspace(
    store: SqliteSessionStore,
    requested: string,
  ): Promise<DesktopBootstrap> {
    const workspace = await realpath(requested);
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
        pendingApprovals.set(id, { sessionId: this.sessionId, resolve: resolveDecision });
        const approval: DesktopApproval = {
          id,
          sessionId: this.sessionId,
          toolName: call.name,
          description,
          canAllowFile:
            (call.name === "write_file" || call.name === "edit_file") &&
            typeof call.args.path === "string",
        };
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
    const config = await loadConfig();
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
    );
    agentsBySession.set(session.id, agent);
    return agent;
  }

  async function dispatch(request: DesktopRequest): Promise<unknown> {
    const store = await storePromise;
    const [first, second, third] = request.args;
    switch (request.method) {
      case "bootstrap":
        return bootstrap(store);
      case "workspace:open":
        return openWorkspace(store, String(first));
      case "session:open": {
        activeSessionId = requireSession(store, String(first)).id;
        return bootstrap(store, activeSessionId);
      }
      case "session:new": {
        if (!activeSessionId) throw new Error("Open a project folder first.");
        const session = store.create(requireSession(store, activeSessionId).workspace);
        activeSessionId = session.id;
        return bootstrap(store, session.id);
      }
      case "session:archive":
      case "session:delete": {
        const sessionId = String(first);
        requireSession(store, sessionId);
        if (runningSessions.has(sessionId))
          throw new Error("Stop the running task before changing this chat.");
        if (request.method === "session:archive") store.archive(sessionId);
        else store.delete(sessionId);
        if (activeSessionId === sessionId) activeSessionId = store.list()[0]?.id;
        return bootstrap(store, activeSessionId);
      }
      case "session:restore": {
        store.restore(String(first));
        return bootstrap(store, activeSessionId);
      }
      case "task:send": {
        const session = requireSession(store, String(first));
        const prompt = second;
        const mode = third;
        if (runningSessions.has(session.id))
          throw new Error("A task is already running in this session.");
        if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Enter a task first.");
        if (mode !== "build" && mode !== "plan") throw new Error("Invalid task mode.");
        runningSessions.add(session.id);
        emit("task:state", { sessionId: session.id, state: "running" });
        void (async () => {
          let state: "complete" | "error" | "cancelled" = "complete";
          let errorMessage: string | undefined;
          try {
            const config = await loadConfig();
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
            if (cancellationRequested.delete(session.id)) {
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
            emit("task:state", {
              sessionId: session.id,
              state: "complete",
              task: agent?.status(session.id),
            });
          } catch (error) {
            state = "error";
            errorMessage = error instanceof Error ? error.message : String(error);
          } finally {
            runningSessions.delete(session.id);
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
        return undefined;
      }
      case "task:cancel": {
        const session = requireSession(store, String(first));
        const agent = agentsBySession.get(session.id);
        const task = agent?.status(session.id);
        if (agent && task && ["planning", "acting", "verifying"].includes(task.status)) {
          agent.cancel(session.id);
          for (const [id, pending] of pendingApprovals) {
            if (pending.sessionId === session.id) {
              pendingApprovals.delete(id);
              pending.resolve(false);
            }
          }
        } else cancellationRequested.add(session.id);
        emit("task:state", { sessionId: session.id, state: "cancelling" });
        return undefined;
      }
      case "workspace:list": {
        const result = await (
          await toolsFor(store, String(first))
        ).execute({ id: crypto.randomUUID(), name: "list_files", args: {} });
        if (!result.ok) throw new Error(result.output);
        return result.output === "No files found." ? [] : result.output.split("\n");
      }
      case "workspace:read": {
        const result = await (
          await toolsFor(store, String(first))
        ).execute({ id: crypto.randomUUID(), name: "read_file", args: { path: second } });
        if (!result.ok) throw new Error(result.output);
        return result.output;
      }
      case "workspace:write": {
        const result = await (
          await toolsFor(store, String(first))
        ).execute({
          id: crypto.randomUUID(),
          name: "write_file",
          args: { path: second, content: third },
        });
        if (!result.ok) throw new Error(result.output);
        return undefined;
      }
      case "workspace:changes":
        return changedWorkspaceFiles(requireSession(store, String(first)).workspace);
      case "workspace:diff": {
        const review = changedFileReview(
          requireSession(store, String(first)).workspace,
          String(second),
        );
        return { diff: review.diff, unavailable: review.unavailable };
      }
      case "model:save": {
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
        await setModelSelection({ provider: provider.id, model: selection.model.trim() });
        await setAutoModelRoutingEnabled(false);
        return bootstrap(store);
      }
      case "approval:resolve": {
        const id = String(first);
        const decision = second;
        const pending = pendingApprovals.get(id);
        if (!pending) return undefined;
        pendingApprovals.delete(id);
        pending.resolve(
          decision === "deny" ? false : decision === "task_file" ? "task_file" : true,
        );
        return undefined;
      }
      case "shutdown":
        await close();
        return undefined;
      default:
        throw new Error(`Unknown desktop runtime method: ${request.method}`);
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const pending of pendingApprovals.values()) pending.resolve(false);
    pendingApprovals.clear();
    for (const [sessionId, agent] of agentsBySession) agent.cancel(sessionId);
    (await storePromise).close();
  }

  return {
    ready: storePromise.then((store) => {
      activeSessionId = store.list()[0]?.id;
    }),
    dispatch,
    close,
  };
}
