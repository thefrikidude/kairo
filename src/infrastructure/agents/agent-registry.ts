import { AcpAgentAdapter } from "./acp-agent.js";
import type { UsageChange } from "../../domain/agent-usage.js";
import type { ExternalAgentAdapter, ExternalAgentInfo } from "../../domain/agent-runtime.js";
import { CodexAgentAdapter } from "./codex-agent.js";

/** Additional agents register protocol adapters here, without changes to chat/session routing. */
export class AgentRegistry {
  private readonly adapters: Map<string, ExternalAgentAdapter>;
  constructor(
    adapters: ExternalAgentAdapter[] = [
      new AcpAgentAdapter("opencode", "OpenCode"),
      new CodexAgentAdapter(),
    ],
  ) {
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
  onUsageChanged(listener: (agentId: string, reason: UsageChange) => void): () => void {
    const stop = [...this.adapters.values()].map((adapter) =>
      adapter.onUsageChanged?.((reason) => listener(adapter.id, reason)),
    );
    return () => stop.forEach((unsubscribe) => unsubscribe?.());
  }
  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close()));
  }
}
