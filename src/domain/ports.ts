import type { ContextCheckpoint, Message, ModelTurn, Task, ToolCall, ToolResult } from "./models.js";

export interface ModelProvider {
  stream(messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn>;
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
  messages(sessionId: string): Message[];
  recentMessages(sessionId: string, limit: number): Message[];
  addMessage(sessionId: string, message: Message): void;
  recordTool(sessionId: string, id: string, name: string, args: Record<string, unknown>, approved: boolean | null, output: string): void;
  startTask(sessionId: string, prompt: string): Task;
  task(id: string): Task | undefined;
  latestTask(sessionId: string): Task | undefined;
  updateTask(id: string, patch: Partial<Pick<Task, "status" | "changedFiles" | "verificationCommand" | "verificationOutput" | "verificationPassed" | "summary" | "error">>): Task;
  saveCheckpoint(sessionId: string, taskId: string | undefined, summary: string, throughMessageId: number): ContextCheckpoint;
  latestCheckpoint(sessionId: string): ContextCheckpoint | undefined;
  messageCount(sessionId: string): number;
  lastMessageId(sessionId: string): number;
}

export interface ApprovalPolicy { approve(call: ToolCall, description: string): Promise<boolean>; }
export interface CredentialStore { get(): Promise<string | undefined>; save(value: string): Promise<void>; clear(): Promise<void>; }
