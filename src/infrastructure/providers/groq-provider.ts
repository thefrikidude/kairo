import Groq from "groq-sdk";
import { modelSystemInstruction } from "../../application/model-system-instruction.js";
import { ProviderError, type ProviderProgress } from "../../domain/provider-error.js";
import type { Message, ModelTurn } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import { recoverProvider } from "./provider-recovery.js";

type PendingToolCall = { id?: string; name: string; arguments: string };

export class GroqProvider implements ModelProvider {
  private readonly client: Groq;

  /** Configures Groq without hidden SDK retries so Kairo owns recovery reporting. */
  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly tools: ToolDefinition[],
  ) {
    this.client = new Groq({ apiKey, maxRetries: 0 });
  }

  /** Streams Groq text and reconstructs incremental OpenAI-style tool calls. */
  async stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: ProviderProgress) => void,
  ): Promise<ModelTurn> {
    return recoverProvider(
      (markContent) => this.streamOnce(messages, onText, markContent),
      onProgress,
      undefined,
      "Groq",
    );
  }

  /** Performs one request and rejects malformed tool arguments before execution. */
  private async streamOnce(
    messages: Message[],
    onText: (chunk: string) => void,
    markContent: () => void,
  ): Promise<ModelTurn> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages: [
        { role: "system", content: modelSystemInstruction },
        ...messages.map((message) => this.message(message)),
      ] as never,
      tools: this.tools.map(({ name, description, parameters }) => ({
        type: "function" as const,
        function: { name, description, parameters },
      })) as never,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    let text = "";
    const pending = new Map<number, PendingToolCall>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        markContent();
        text += delta.content;
        onText(delta.content);
      }
      for (const call of delta?.tool_calls ?? []) {
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
          throw new ProviderError("request", false, undefined, "Groq");
        }
      });
    return { text, toolCalls };
  }

  /** Converts Kairo's durable message representation to Groq chat messages. */
  private message(message: Message): unknown {
    if (message.role === "tool")
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
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
    return {
      role: message.role === "model" ? "assistant" : "user",
      content: message.content,
    };
  }
}
