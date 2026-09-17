import { GoogleGenAI } from "@google/genai";
import { recoverProvider } from "./provider-recovery.js";
import type { ProviderProgress } from "../../domain/provider-error.js";
import type { Message, ModelTurn } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import { modelSystemInstruction } from "../../application/model-system-instruction.js";

export class GeminiProvider implements ModelProvider {
  private readonly client: GoogleGenAI;
  /** Configures the Gemini client with the selected model and Kairo tool schema. */
  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly tools: ToolDefinition[],
  ) {
    // This SDK version uses a single fetch when retryOptions is absent.
    // Enabling its retry wrapper discards HTTP status and structured retry hints.
    this.client = new GoogleGenAI({ apiKey });
  }
  /** Streams Gemini text and normalizes function calls into the provider-neutral model turn. */
  async stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: ProviderProgress) => void,
    systemInstruction = modelSystemInstruction,
  ): Promise<ModelTurn> {
    return recoverProvider(
      (markContent) =>
        this.streamOnce(
          messages,
          (text) => {
            markContent();
            onText(text);
          },
          markContent,
          systemInstruction,
        ),
      onProgress,
      undefined,
      "Gemini",
    );
  }
  /** Performs one stream; received calls prevent automatic replay even before execution. */
  private async streamOnce(
    messages: Message[],
    onText: (chunk: string) => void,
    markContent: () => void,
    systemInstruction: string,
  ): Promise<ModelTurn> {
    const contents = messages.map((message) => {
      if (message.role === "tool")
        return {
          role: "user",
          parts: [
            { functionResponse: { name: message.toolName, response: { result: message.content } } },
          ],
        };
      if (message.role === "model" && message.toolCallId && message.toolName)
        return {
          role: "model",
          parts: [
            {
              functionCall: {
                id: message.toolCallId,
                name: message.toolName,
                args: JSON.parse(message.content),
              },
            },
          ],
        };
      return {
        role: message.role === "model" ? "model" : "user",
        parts: [{ text: message.content }],
      };
    });
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: contents as never,
      config: {
        systemInstruction,
        tools: [
          {
            functionDeclarations: this.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          },
        ],
      } as never,
    });
    let text = "";
    const calls: ModelTurn["toolCalls"] = [];
    for await (const chunk of stream) {
      const chunkText =
        chunk.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      if (chunkText) {
        text += chunkText;
        onText(chunkText);
      }
      for (const call of chunk.functionCalls ?? []) {
        markContent();
        calls.push({
          id: call.id || crypto.randomUUID(),
          name: String(call.name),
          args: (call.args || {}) as Record<string, unknown>,
        });
      }
    }
    return { text, toolCalls: calls };
  }
}
