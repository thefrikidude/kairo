/** A CLI owns its conversation; Kairo owns the workspace and terminal session. */
export type NativeAgentSession = { id: string; transcriptPath?: string };
export type TerminalAgentDefinition = {
  id: string;
  name: string;
  commands: readonly string[];
  args: readonly string[];
  homepage: string;
  requiredCommands?: readonly string[];
  env?: Readonly<Record<string, string>>;
};
export type TerminalAgentInfo = TerminalAgentDefinition & {
  installed: boolean;
  executable?: string;
  unavailableReason?: string;
  resumable: boolean;
  resumePicker?: boolean;
};
export type TerminalSession = {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastStartedAt?: number;
  archivedAt?: number;
  nativeSession?: NativeAgentSession;
};
export type TerminalLaunch = {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  title: string;
  sessionId?: string;
};

export type SessionStartMode = "auto" | "fresh" | "picker";
