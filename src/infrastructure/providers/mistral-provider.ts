import { modelSystemInstruction } from "../../application/model-system-instruction.js";
import { ProviderError, type ProviderProgress } from "../../domain/provider-error.js";
import type { Message, ModelTurn } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import { recoverProvider } from "./provider-recovery.js";

type PendingToolCall = { id?: string; name: string; arguments: string };

/** Adapts Mistral's OpenAI-compatible Chat Completions API to Kairo's provider contract. */
export class MistralProvider implements ModelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly tools: ToolDefinition[],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: ProviderProgress) => void,
    systemInstruction = modelSystemInstruction,
    toolsEnabled = true,
  ): Promise<ModelTurn> {
    return recoverProvider(
      (markContent) =>
        this.streamOnce(messages, onText, markContent, systemInstruction, toolsEnabled),
      onProgress,
      undefined,
      "Mistral",
    );
  }

  private async streamOnce(
    messages: Message[],
    onText: (chunk: string) => void,
    markContent: () => void,
    systemInstruction: string,
    toolsEnabled: boolean,
  ): Promise<ModelTurn> {
    const response = await this.fetcher("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map((message) => this.message(message)),
        ],
        ...(toolsEnabled
          ? {
              tools: this.tools.map(({ name, description, parameters }) => ({
                type: "function",
                function: { name, description, parameters },
              })),
              tool_choice: "auto",
              parallel_tool_calls: false,
            }
          : {}),
      }),
    });
    if (!response.ok) throw this.error(response.status);
    if (!response.body) throw new ProviderError("service", true, undefined, "Mistral");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const pending = new Map<number, PendingToolCall>();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!payload || payload === "[DONE]") continue;
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          throw new ProviderError("service", true, undefined, "Mistral");
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          markContent();
          text += delta.content;
          onText(delta.content);
        }
        for (const call of delta?.tool_calls ?? []) {
          markContent();
          const index = call.index ?? 0;
          const current = pending.get(index) ?? { name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          pending.set(index, current);
        }
      }
    }
    return {
      text,
      toolCalls: [...pending.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => {
          try {
            return {
              id: call.id || crypto.randomUUID(),
              name: call.name,
              args: JSON.parse(call.arguments || "{}") as Record<string, unknown>,
            };
          } catch {
            throw new ProviderError("request", false, undefined, "Mistral");
          }
        }),
    };
  }

  private message(message: Message): Record<string, unknown> {
    if (message.role === "tool")
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    if (message.role === "model" && message.toolCallId && message.toolName)
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: message.toolCallId,
            type: "function",
            function: { name: message.toolName, arguments: message.content },
          },
        ],
      };
    return { role: message.role === "model" ? "assistant" : "user", content: message.content };
  }

  private error(status: number): ProviderError {
    if (status === 401 || status === 403)
      return new ProviderError("authentication", false, undefined, "Mistral");
    if (status === 429) return new ProviderError("quota", true, undefined, "Mistral");
    if (status >= 500) return new ProviderError("service", true, undefined, "Mistral");
    return new ProviderError("request", false, undefined, "Mistral");
  }
}
