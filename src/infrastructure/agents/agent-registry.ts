import type { ExternalAgentAdapter, ExternalAgentInfo } from "../../domain/agent-runtime.js";
import { CodexAgentAdapter } from "./codex-agent.js";

/** Additional agents register protocol adapters here, without changes to chat/session routing. */
export class AgentRegistry {
  private readonly adapters: Map<string, ExternalAgentAdapter>;
  constructor(adapters: ExternalAgentAdapter[] = [new CodexAgentAdapter()]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }
  get(id: string): ExternalAgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`No native-chat adapter is available for ${id}.`);
    return adapter;
  }
  async inspect(): Promise<ExternalAgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.inspect()));
  }
  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close()));
  }
}
