export type Role = "user" | "model" | "tool";

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
