import type {
  ContextCheckpoint,
  Message,
  ModelTurn,
  Task,
  ToolCall,
  ToolResult,
  RepairAttempt,
  TaskEvent,
  EvaluationAttempt,
  EvaluationRun,
  ProviderId,
  CredentialId,
  TaskMode,
} from "./models.js";

export interface ModelProvider {
  stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: import("./provider-error.js").ProviderProgress) => void,
    systemInstruction?: string,
  ): Promise<ModelTurn>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
}

export interface ToolExecutor {
  readonly root: string;
  description(call: ToolCall): string;
  execute(call: ToolCall): Promise<ToolResult>;
}

export interface TaskStore {
  /** Appends metadata for one observable task operation. */
  recordTaskEvent(event: TaskEvent): void;
  /** Returns events in durable insertion order, including earlier resumed runs. */
  taskEvents(taskId: string): TaskEvent[];
  messages(sessionId: string): Message[];
  recentMessages(sessionId: string, limit: number): Message[];
  addMessage(sessionId: string, message: Message): void;
  recordTool(
    sessionId: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
    approved: boolean | null,
    output: string,
  ): void;
  startTask(sessionId: string, prompt: string, mode?: TaskMode): Task;
  task(id: string): Task | undefined;
  latestTask(sessionId: string): Task | undefined;
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | "status"
        | "mode"
        | "plan"
        | "changedFiles"
        | "verificationCommand"
        | "verificationOutput"
        | "verificationPassed"
        | "verificationExitCode"
        | "verificationDiscovered"
        | "verificationSelection"
        | "summary"
        | "error"
      >
    >,
  ): Task;
  saveCheckpoint(
    sessionId: string,
    taskId: string | undefined,
    summary: string,
    throughMessageId: number,
  ): ContextCheckpoint;
  latestCheckpoint(sessionId: string): ContextCheckpoint | undefined;
  messageCount(sessionId: string): number;
  lastMessageId(sessionId: string): number;
  saveRepositoryProfile(sessionId: string, profile: import("./models.js").RepositoryProfile): void;
  repositoryProfile(sessionId: string): import("./models.js").RepositoryProfile | undefined;
  recordRepairAttempt(attempt: RepairAttempt): void;
  repairAttempts(taskId: string): RepairAttempt[];
}

export interface ApprovalPolicy {
  approve(call: ToolCall, description: string): Promise<boolean>;
}
export interface CredentialStore {
  get(provider: CredentialId): Promise<string | undefined>;
  save(provider: CredentialId, value: string): Promise<void>;
  clear(provider: CredentialId): Promise<void>;
}

export type JevRisk = "low" | "medium" | "high";
export type JevRoute = "build" | "plan";
export type JevRecovery = "repair" | "broaden" | "escalate";
export interface JevDecision<T extends string> {
  value: T;
  confidence: number;
}
export interface JevAssessment {
  risk: JevRisk;
  confidence: number;
}
/** Classifies safe operation metadata; it never authorizes an action. */
export interface JevSafetyAdvisor {
  assess(state: string): Promise<JevAssessment>;
  route(state: string): Promise<JevDecision<JevRoute>>;
  recover(state: string): Promise<JevDecision<JevRecovery>>;
}
export interface JevFeatures {
  routing: boolean;
  safety: boolean;
  recovery: boolean;
}

/** Stores metadata-only reliability evidence separately from raw task history. */
export interface EvaluationStore {
  setEvaluationBaseline(runId: string): EvaluationRun;
  evaluationBaseline(): EvaluationRun | undefined;
  createEvaluationRun(
    input: Omit<EvaluationRun, "id" | "attemptCount" | "passedCount">,
  ): EvaluationRun;
  saveEvaluationAttempt(attempt: EvaluationAttempt): void;
  completeEvaluationRun(id: string): EvaluationRun;
  evaluationRuns(limit?: number): EvaluationRun[];
  evaluationRun(id: string): EvaluationRun | undefined;
  evaluationAttempts(runId: string): EvaluationAttempt[];
}
