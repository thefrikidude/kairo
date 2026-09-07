export type Role = "user" | "model" | "tool";

/** Metadata-only events avoid copying source code, credentials, or command output into traces. */
export interface TaskEvent {
  id?: number;
  taskId: string;
  kind:
    | "status"
    | "model_started"
    | "model_finished"
    | "tool_requested"
    | "tool_started"
    | "tool_finished"
    | "approval"
    | "repair"
    | "verification"
    | "verification_selected";
  createdAt: number;
  operationId?: string;
  name?: string;
  outcome?: string;
  durationMs?: number;
  exitCode?: number | null;
}

export interface Message {
  role: Role;
  content: string;
  createdAt: number;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
}
export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | null;
  durationMs?: number;
}

export interface VerificationCandidate {
  label: "test" | "typecheck" | "lint" | "build";
  command: string;
  /** Discovery metadata explains a recommendation without retaining source or output. */
  scope?: "focused" | "broad";
  reason?: string;
}

/** Records why one safe verification command was selected for a task. */
export interface VerificationSelection {
  command: string;
  label: VerificationCandidate["label"] | "custom";
  scope: "focused" | "broad";
  reason: string;
  source: "recommended" | "model" | "manual" | "repair";
}

export interface RepositoryFile {
  path: string;
  terms: string[];
  symbols: string[];
  imports: string[];
  relatedFiles: string[];
}

export interface RepositoryProfile {
  root: string;
  packageName?: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  scripts: Record<string, string>;
  configFiles: string[];
  sourceRoots: string[];
  testRoots: string[];
  ignoredPaths: string[];
  indexedFiles: string[];
  files: RepositoryFile[];
  verificationCandidates: VerificationCandidate[];
  createdAt: number;
}

export interface FailureEvidence {
  summary: string;
  fileLocations: Array<{ path: string; line?: number; column?: number }>;
  excerpts: string[];
}

export interface RepairAttempt {
  id: string;
  taskId: string;
  command: string;
  evidence: FailureEvidence;
  selectedFiles: string[];
  createdAt: number;
}

export type TaskStatus =
  | "planning"
  | "acting"
  | "verifying"
  | "completed"
  | "verification_required"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface Task {
  id: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  changedFiles: string[];
  verificationCommand?: string;
  verificationOutput?: string;
  verificationPassed?: boolean;
  verificationExitCode?: number | null;
  verificationDiscovered?: boolean;
  verificationSelection?: VerificationSelection;
  summary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ContextCheckpoint {
  id: string;
  sessionId: string;
  taskId?: string;
  summary: string;
  throughMessageId: number;
  createdAt: number;
}

/** One benchmark result combines the task outcome, an independent verifier, and agent metrics. */
export interface EvaluationResult {
  id: string;
  passed: boolean;
  taskStatus: TaskStatus;
  verified: boolean;
  expectationPassed: boolean;
  error?: string;
  metrics: {
    modelTurns: number;
    toolExecutions: number;
    toolFailures: number;
    approvals: number;
    repairs: number;
    verificationPasses: number;
    verificationFailures: number;
    verificationSelections: number;
    focusedVerifications: number;
    broadVerifications: number;
    repairConverged: boolean;
    modelMs: number;
    toolMs: number;
  };
}

/** A DeepEval verdict is advisory model-quality evidence, alongside deterministic task checks. */
export interface DeepEvalVerdict {
  passed: boolean;
  score?: number;
  reason?: string;
  error?: string;
}

/** A live evaluation combines isolated workspace assertions with an LLM-judged agent trace. */
export interface LiveEvaluationResult extends EvaluationResult {
  judge: DeepEvalVerdict;
}

/** One live run of a Kairo-on-Kairo benchmark task. */
export interface SelfEvaluationResult extends EvaluationResult {
  trial: number;
}

/** Durable metadata for one real-model reliability-suite run. */
export interface EvaluationRun {
  id: string;
  suite: "self";
  model: string;
  sourceRevision: string;
  trialCount: number;
  attemptCount: number;
  passedCount: number;
  startedAt: number;
  completedAt?: number;
}

/** Sanitized attempt data retained for reliability comparisons, never raw agent content. */
export interface EvaluationAttempt {
  runId: string;
  scenarioId: string;
  trial: number;
  passed: boolean;
  taskStatus: TaskStatus;
  verified: boolean;
  expectationPassed: boolean;
  failureCategory?: "agent" | "verification" | "grader" | "setup" | "unknown";
  metrics: EvaluationResult["metrics"];
  durationMs: number;
  createdAt: number;
}
