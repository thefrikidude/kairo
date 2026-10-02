import type { AgentAnswers, AgentQuestion } from "./agent-user-input.js";
import type { ModelSelection } from "./models.js";

/** Runtime identity is fixed once a conversation starts; its model may change between turns. */
export type SessionRuntime =
  | { kind: "builtin"; selection?: ModelSelection }
  | {
      kind: "external";
      agentId: string;
      model?: string;
      /** Codex-native collaboration preference queued until its first real turn. */
      codexMode?: "default" | "plan";
    };

export type AgentModel = { id: string; label: string };
export type ExternalAgentInfo = {
  id: string;
  name: string;
  installed: boolean;
  authenticated: boolean;
  models: AgentModel[];
  error?: string;
};

export type ExternalRun = {
  workspace: string;
  threadId?: string;
  model?: string;
  prompt: string;
  mode: "build" | "plan";
  codexMode?: "default" | "plan";
  signal: AbortSignal;
  onThread(id: string): void;
  onText(text: string): void;
  onTool(id: string, name: string, complete: boolean, outcome?: string): void;
  requestUserInput?(
    questions: AgentQuestion[],
    signal: AbortSignal,
  ): Promise<AgentAnswers | undefined>;
  approve(name: string, description: string): Promise<boolean>;
};

export type ExternalCommand = {
  threadId?: string;
  workspace: string;
  command: "plan" | "default" | "model" | "compact";
  argument?: string;
  model?: string;
};

/** Each adapter owns its agent's protocol and credentials; Kairo never copies CLI tokens. */
export interface ExternalAgentAdapter {
  readonly id: string;
  readonly name: string;
  inspect(): Promise<ExternalAgentInfo>;
  login(): Promise<{ url: string }>;
  run(input: ExternalRun): Promise<"complete" | "cancelled">;
  executeCommand?(input: ExternalCommand): Promise<string>;
  close(): Promise<void>;
}
