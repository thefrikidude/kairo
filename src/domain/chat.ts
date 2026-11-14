/**
 * What a chat message is. Only `user`, `notice` and `switch` exist today; `agent`, `tool_call` and
 * `permission` are reserved for agents that speak ACP, so those can be stored without a migration.
 */
export type ChatEventKind = "user" | "agent" | "notice" | "switch" | "tool_call" | "permission";
export type ChatEvent = {
  id: string;
  kind: ChatEventKind;
  text: string;
  /** The agent selected when the event happened. */
  agentId?: string;
  createdAt: number;
};
/** A chat's saved history and its selected agent. The thread of a chat is its workspace's id. */
export type ChatThread = { agentId?: string; events: ChatEvent[] };
