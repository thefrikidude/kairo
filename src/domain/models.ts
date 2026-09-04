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
