import { ProviderError } from "../domain/provider-error.js";
import type { CodingAgent } from "./coding-agent.js";

/** Captures failure before the caller closes the store, allowing metrics to be read. */
export async function runEvaluatedAgent(
  agent: CodingAgent,
  sessionId: string,
  prompt: string,
  onProgress?: (text: string) => void,
): Promise<{ error?: string; category?: "agent" | ProviderError["category"] }> {
  try {
    await agent.run(sessionId, prompt, (text) => {
      if (text.startsWith("\n[") && /: (?:retry|stopped retrying)/.test(text)) onProgress?.(text);
    });
    return {};
  } catch (error) {
    return error instanceof ProviderError
      ? { error: error.message, category: error.category }
      : { error: "Agent execution failed.", category: "agent" };
  }
}
