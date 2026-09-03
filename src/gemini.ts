import { GoogleGenAI } from "@google/genai";
import type { Message, ModelProvider, ModelTurn, ToolDefinition } from "./types.js";

const systemInstruction = "You are Kairo, a careful coding agent. Work only through the provided tools. Inspect before changing code. Explain your result concisely. Tool results may be truncated.";

export class GeminiProvider implements ModelProvider {
  private readonly client: GoogleGenAI;
  constructor(apiKey: string, private readonly model: string, private readonly tools: ToolDefinition[]) { this.client = new GoogleGenAI({ apiKey }); }
  async stream(messages: Message[], onText: (chunk: string) => void): Promise<ModelTurn> {
    const contents = messages.map((message) => {
      if (message.role === "tool") return { role: "user", parts: [{ functionResponse: { name: message.toolName, response: { result: message.content } } }] };
      if (message.role === "model" && message.toolCallId && message.toolName) return { role: "model", parts: [{ functionCall: { id: message.toolCallId, name: message.toolName, args: JSON.parse(message.content) } }] };
      return { role: message.role === "model" ? "model" : "user", parts: [{ text: message.content }] };
    });
    const stream = await this.client.models.generateContentStream({ model: this.model, contents: contents as never, config: { systemInstruction, tools: [{ functionDeclarations: this.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] } as never });
    let text = ""; const calls: ModelTurn["toolCalls"] = [];
    for await (const chunk of stream) {
      if (chunk.text) { text += chunk.text; onText(chunk.text); }
      for (const call of chunk.functionCalls ?? []) calls.push({ id: call.id || crypto.randomUUID(), name: String(call.name), args: (call.args || {}) as Record<string, unknown> });
    }
    return { text, toolCalls: calls };
  }
}
