import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { jsonSchema, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { modelSystemInstruction } from "../../application/model-system-instruction.js";
import type { Message, ModelTurn, ProviderId } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import type { ProviderProgress } from "../../domain/provider-error.js";
import { ProviderError } from "../../domain/provider-error.js";
import { recoverProvider } from "./provider-recovery.js";

type ProviderClientOptions = { fetcher?: typeof fetch };

/** Shared AI SDK streaming adapter; Kairo retains orchestration, tool execution, and recovery. */
export class SdkProvider implements ModelProvider {
  private readonly model: LanguageModel;
  private readonly tools: ToolSet;

  constructor(
    private readonly provider: ProviderId,
    apiKey: string,
    private readonly modelId: string,
    definitions: ToolDefinition[],
    options: ProviderClientOptions = {},
  ) {
    const fetch = options.fetcher;
    switch (provider) {
      case "gemini":
        this.model = createGoogle({ apiKey, fetch })(modelId);
        break;
      case "groq":
        this.model = createGroq({ apiKey, fetch })(modelId);
        break;
      case "mistral":
        this.model = createMistral({ apiKey, fetch })(modelId);
        break;
      case "openrouter":
        this.model = createOpenRouter({
          apiKey,
          appName: "Kairo",
          compatibility: "strict",
          fetch,
        }).chat(modelId);
        break;
    }
    this.tools = Object.fromEntries(
      definitions.map(({ name, description, parameters }) => [
        name,
        { description, inputSchema: jsonSchema(parameters) },
      ]),
    );
  }

  stream(
    messages: Message[],
    onText: (chunk: string) => void,
    onProgress?: (event: ProviderProgress) => void,
    systemInstruction = modelSystemInstruction,
    toolsEnabled = true,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    return recoverProvider(
      (markContent) =>
        this.streamOnce(messages, onText, markContent, systemInstruction, toolsEnabled, signal),
      onProgress,
      undefined,
      providerName(this.provider),
      this.provider !== "openrouter" || !isFreeModel(this.modelId),
      signal,
    );
  }

  private async streamOnce(
    messages: Message[],
    onText: (chunk: string) => void,
    markContent: () => void,
    systemInstruction: string,
    toolsEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<ModelTurn> {
    const result = streamText({
      model: this.model,
      system: systemInstruction,
      messages: toModelMessages(messages),
      ...(toolsEnabled ? { tools: this.tools, toolChoice: "auto" as const } : {}),
      ...(toolsEnabled && this.provider !== "gemini"
        ? { providerOptions: { [this.provider]: { parallelToolCalls: false } } }
        : {}),
      abortSignal: signal,
      // Kairo's recovery layer owns retries and emits retry progress to the TUI.
      maxRetries: 0,
      // Provider errors are normalized and shown by Kairo; never dump raw SDK errors to stderr.
      onError: () => {},
    });

    const text: string[] = [];
    const toolCalls: ModelTurn["toolCalls"] = [];
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          markContent();
          text.push(part.text);
          onText(part.text);
        } else if (part.type === "tool-input-start" || part.type === "tool-input-delta") {
          // Avoid replay if a provider fails after beginning to emit a tool call.
          markContent();
        } else if (part.type === "tool-call") {
          markContent();
          toolCalls.push({
            id: part.toolCallId,
            name: part.toolName,
            args: asToolArguments(part.input, this.provider),
          });
        } else if (part.type === "error") {
          throw part.error;
        }
      }
    } catch (error) {
      throw normalizeToolParseError(error, this.provider);
    }
    return { text: text.join(""), toolCalls };
  }
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "tool") {
      if (!message.toolCallId || !message.toolName) throw new ProviderError("request", false);
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: { type: "text", value: message.content },
          },
        ],
      };
    }
    if (message.role === "model" && message.toolCallId && message.toolName) {
      let input: unknown;
      try {
        input = JSON.parse(message.content);
      } catch {
        throw new ProviderError("request", false);
      }
      return {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            input,
          },
        ],
      };
    }
    return { role: message.role === "model" ? "assistant" : "user", content: message.content };
  });
}

function asToolArguments(input: unknown, provider: ProviderId): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input))
    return input as Record<string, unknown>;
  throw new ProviderError("request", false, undefined, providerName(provider));
}

function normalizeToolParseError(error: unknown, provider: ProviderId): unknown {
  if (error instanceof SyntaxError || error instanceof TypeError)
    return new ProviderError("request", false, undefined, providerName(provider));
  return error;
}

function providerName(provider: ProviderId): string {
  return provider === "openrouter" ? "OpenRouter" : provider[0]!.toUpperCase() + provider.slice(1);
}

function isFreeModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}
