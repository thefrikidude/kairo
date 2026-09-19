import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages, ChatStreamChunk } from "@openrouter/sdk/models";
import { modelSystemInstruction } from "../../application/model-system-instruction.js";
import { ProviderError, type ProviderProgress } from "../../domain/provider-error.js";
import type { Message, ModelTurn } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import { recoverProvider } from "./provider-recovery.js";

type PendingToolCall = { id?: string; name: string; arguments: string };

/** Adapts OpenRouter's OpenAI-compatible chat API to Kairo's provider contract. */
export class OpenRouterProvider implements ModelProvider {
  private readonly client: OpenRouter;
  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly tools: ToolDefinition[],
  ) {
    this.client = new OpenRouter({
      apiKey,
      appTitle: "Kairo",
      // Kairo owns retry behavior so transcript progress remains accurate.
      retryConfig: { strategy: "none" },
    });
  }

  async stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: ProviderProgress) => void,
    systemInstruction = modelSystemInstruction,
  ): Promise<ModelTurn> {
    return recoverProvider(
      (markContent) => this.streamOnce(messages, onText, markContent, systemInstruction),
      onProgress,
      undefined,
      "OpenRouter",
      !this.isFreeModel(),
    );
  }

  private async streamOnce(
    messages: Message[],
    onText: (chunk: string) => void,
    markContent: () => void,
    systemInstruction: string,
  ): Promise<ModelTurn> {
    const stream = (await this.client.chat.send({
      chatRequest: {
        model: this.model,
        stream: true,
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map((message) => this.message(message)),
        ] as ChatMessages[],
        tools: this.tools.map(({ name, description, parameters }) => ({
          type: "function" as const,
          function: { name, description, parameters },
        })),
        toolChoice: "auto",
        parallelToolCalls: false,
      },
    })) as AsyncIterable<ChatStreamChunk>;
    let text = "";
    const pending = new Map<number, PendingToolCall>();
    for await (const chunk of stream) {
      if (chunk.error) throw { status: chunk.error.code };
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        markContent();
        text += delta.content;
        onText(delta.content);
      }
      for (const call of delta?.toolCalls ?? []) {
        markContent();
        const current = pending.get(call.index) ?? { name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        pending.set(call.index, current);
      }
    }
    const toolCalls = [...pending.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => {
        try {
          return {
            id: call.id || crypto.randomUUID(),
            name: call.name,
            args: JSON.parse(call.arguments || "{}") as Record<string, unknown>,
          };
        } catch {
          throw new ProviderError("request", false, undefined, "OpenRouter");
        }
      });
    return { text, toolCalls };
  }

  private message(message: Message): ChatMessages {
    if (message.role === "tool")
      return { role: "tool", toolCallId: message.toolCallId!, content: message.content };
    if (message.role === "model" && message.toolCallId && message.toolName)
      return {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: message.toolCallId,
            type: "function",
            function: { name: message.toolName, arguments: message.content },
          },
        ],
      };
    return { role: message.role === "model" ? "assistant" : "user", content: message.content };
  }

  /** Free endpoints are rate-limited; do not consume their small allowance with automatic retries. */
  private isFreeModel(): boolean {
    return this.model === "openrouter/free" || this.model.endsWith(":free");
  }
}
