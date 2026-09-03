export type Role = "user" | "model" | "tool";

export interface Message {
  role: Role;
  content: string;
  createdAt: number;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; }
export interface ModelTurn { text: string; toolCalls: ToolCall[]; }

export interface ModelProvider {
  stream(messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
}

export interface ToolResult { ok: boolean; output: string; }
export interface ApprovalPolicy { approve(call: ToolCall, description: string): Promise<boolean>; }
export interface CredentialStore { get(): Promise<string | undefined>; save(value: string): Promise<void>; clear(): Promise<void>; }

export type TaskStatus = "planning" | "acting" | "verifying" | "completed" | "verification_required" | "failed" | "interrupted" | "cancelled";

export interface Task {
  id: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  changedFiles: string[];
  verificationCommand?: string;
  verificationOutput?: string;
  verificationPassed?: boolean;
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
