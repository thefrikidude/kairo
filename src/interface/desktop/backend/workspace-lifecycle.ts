import { randomUUID } from "node:crypto";
import type {
  TaskWorkspace,
  WorkspaceCreation,
  WorkspaceOperation,
  ProjectPreferences,
} from "../../../domain/task-workspace.js";
import { GitWorkspaces } from "../../../infrastructure/repository/git-workspaces.js";
import { SqliteTerminalSessionStore } from "../../../infrastructure/persistence/sqlite-terminal-session-store.js";
import {
  copyWorkspacePaths,
  literalPath,
  runWorkspaceSetup,
} from "../../../infrastructure/workspaces/workspace-preparation.js";
const active = (op: WorkspaceOperation) => ["checkout", "copy", "setup"].includes(op.phase);

/** Background preparation is durable; terminal navigation never awaits its completion. */
export class WorkspaceLifecycle {
  private runs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  constructor(
    private store: SqliteTerminalSessionStore,
    private git: GitWorkspaces,
    private changed: () => void,
    private launch: (workspaceId: string, agentId: string) => Promise<void>,
  ) {}
  async reconcile(): Promise<void> {
    for (const operation of this.store.operations().filter(active)) {
      await this.adopt(operation).catch(() => {});
      operation.phase = "interrupted";
      operation.error =
        "Preparation was interrupted. Retry or open a shell; setup was not restarted.";
      this.save(operation);
    }
  }
  private save(operation: WorkspaceOperation): void {
    this.store.saveOperation(operation);
    this.changed();
  }
  private async adopt(operation: WorkspaceOperation): Promise<TaskWorkspace | undefined> {
    const tree = (await this.git.list(operation.repositoryPath)).find(
      (tree) => tree.directory === operation.directory && !tree.prunable,
    );
    if (!tree || tree.branch !== operation.branch) return undefined;
    const workspace = this.store.registerWorkspace({
      ...(await this.git.describe(operation.directory)),
      managed: true,
      baseCommit: operation.baseCommit,
    });
    operation.workspaceId = workspace.id;
    this.store.updateWorkspace(workspace.id, { name: operation.name });
    return workspace;
  }
  busy(workspaceId: string): boolean {
    return this.store
      .operations()
      .some((op) => op.workspaceId === workspaceId && this.runs.has(op.id));
  }
  async preferences(project: string, input?: unknown): Promise<ProjectPreferences> {
    const repositoryPath = (await this.git.describe(project)).repositoryPath;
    if (input == null) return this.store.preferences(repositoryPath);
    const value = input as Partial<ProjectPreferences>;
    if (
      !value ||
      typeof value.setupScript !== "string" ||
      value.setupScript.length > 16_000 ||
      !Array.isArray(value.copyPaths) ||
      value.copyPaths.length > 100 ||
      (value.baseRef !== undefined &&
        (typeof value.baseRef !== "string" || value.baseRef.trim().startsWith("-")))
    )
      throw new Error("Invalid project preferences.");
    const preferences = {
      repositoryPath,
      baseRef: value.baseRef?.trim() || undefined,
      setupScript: value.setupScript,
      copyPaths: [...new Set(value.copyPaths.map(literalPath))],
    };
    this.store.savePreferences(preferences);
    return preferences;
  }
  async create(input: WorkspaceCreation): Promise<void> {
    if (this.closed) throw new Error("Kairo is shutting down.");
    if (
      !input ||
      typeof input.project !== "string" ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 200 ||
      !input.selection
    )
      throw new Error("Enter a workspace name and project.");
    const project = await this.git.describe(input.project);
    if (input.selection.kind !== "worktree") {
      const description =
        input.selection.kind === "folder"
          ? project
          : input.selection.kind === "existing"
            ? await this.git.existing(input.project, input.selection.directory)
            : undefined;
      if (!description) throw new Error("Choose a workspace mode.");
      const workspace = this.store.registerWorkspace(description);
      if (workspace.archivedAt) throw new Error("Restore this workspace before adding tabs.");
      this.store.updateWorkspace(workspace.id, { name: input.name.trim() });
      this.store.setActiveSession(undefined);
      this.store.setActiveWorkspace(workspace.id);
      if (input.agentId) await this.launch(workspace.id, input.agentId);
      return;
    }
    const preferences = this.store.preferences(project.repositoryPath);
    const baseRef =
      input.selection.baseRef ||
      (await this.git.refs(project.repositoryPath, preferences.baseRef)).defaultRef;
    const plan = await this.git.plan(
      project.repositoryPath,
      input.name,
      input.selection.branch || undefined,
      baseRef,
    );
    const operation: WorkspaceOperation = {
      id: randomUUID(),
      repositoryPath: plan.repositoryPath,
      directory: plan.directory,
      branch: plan.branch,
      baseCommit: plan.baseCommit,
      name: input.name.trim(),
      agentId: input.agentId,
      preferences,
      copiedPaths: [],
      phase: "checkout",
      output: "",
      createdAt: Date.now(),
    };
    this.save(operation);
    this.run(operation);
  }
  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error("Preparation is no longer running.");
    run.controller.abort();
  }
  async retry(id: string): Promise<void> {
    if (this.closed || this.runs.has(id))
      throw new Error("Preparation is already running or shutting down.");
    const op = this.store.operations().find((op) => op.id === id);
    if (!op || active(op) || op.phase === "ready")
      throw new Error("Choose a failed or interrupted preparation.");
    if (
      op.workspaceId &&
      (this.store.workspace(op.workspaceId)?.archivedAt ||
        this.store.workspace(op.workspaceId)?.removedAt)
    )
      throw new Error("Restore this workspace before retrying.");
    op.preferences = this.store.preferences(op.repositoryPath);
    op.error = undefined;
    op.phase = op.workspaceId ? "copy" : "checkout";
    this.save(op);
    this.run(op);
  }
  private run(op: WorkspaceOperation): void {
    const controller = new AbortController();
    // Defer work until its cancellation handle has been registered.
    const promise = Promise.resolve().then(async () => {
      let logTimer: ReturnType<typeof setTimeout> | undefined;
      const output = (text: string) => {
        op.output = (op.output + text).slice(-32_000);
        logTimer ??= setTimeout(() => {
          logTimer = undefined;
          this.save(op);
        }, 100);
      };
      try {
        if (!op.workspaceId) {
          let workspace = await this.adopt(op);
          if (!workspace) {
            await this.git.checkout(
              {
                repositoryPath: op.repositoryPath,
                directory: op.directory,
                kind: "worktree",
                managed: true,
                branch: op.branch,
                baseCommit: op.baseCommit,
              },
              controller.signal,
            );
            workspace = await this.adopt(op);
          }
          if (!workspace)
            throw new Error(
              "Checkout was created but could not be registered. Retry to recover it.",
            );
          this.save(op);
        }
        controller.signal.throwIfAborted();
        const workspace = this.store.workspace(op.workspaceId!)!;
        this.store.updateWorkspace(workspace.id, { unavailable: false });
        op.phase = "copy";
        this.save(op);
        await copyWorkspacePaths(
          op.repositoryPath,
          workspace.directory,
          op.preferences.copyPaths,
          op.copiedPaths,
          controller.signal,
          (path) => {
            op.copiedPaths.push(path);
            this.save(op);
          },
        );
        op.phase = "setup";
        this.save(op);
        await runWorkspaceSetup(
          op.preferences.setupScript,
          op.repositoryPath,
          workspace.directory,
          controller.signal,
          output,
        );
        controller.signal.throwIfAborted();
        op.phase = "ready";
        this.save(op);
        if (op.agentId && !this.closed) {
          try {
            await this.launch(workspace.id, op.agentId);
          } catch (error) {
            op.error = `Workspace ready; agent launch failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } catch (error) {
        // Git may finish just before cancellation; retain and catalog any surviving checkout.
        await this.adopt(op).catch(() => {});
        op.phase = controller.signal.aborted ? "cancelled" : "failed";
        op.error = controller.signal.aborted
          ? "Preparation cancelled. Created files are retained."
          : error instanceof Error
            ? error.message
            : String(error);
        this.save(op);
      } finally {
        if (logTimer) clearTimeout(logTimer);
        this.save(op);
        this.runs.delete(op.id);
      }
    });
    this.runs.set(op.id, { controller, promise });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) run.controller.abort();
    await Promise.allSettled([...this.runs.values()].map((run) => run.promise));
  }
}
