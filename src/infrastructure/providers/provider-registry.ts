import type { ModelSelection, ProviderId } from "../../domain/models.js";
import type { ModelProvider, ToolDefinition } from "../../domain/ports.js";
import { GeminiProvider } from "./gemini-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { MistralProvider } from "./mistral-provider.js";

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  environmentVariable: string;
  models: Array<{
    id: string;
    label: string;
    tier: "fast" | "balanced" | "strong";
    recommended?: boolean;
  }>;
  create(apiKey: string, model: string, tools: ToolDefinition[]): ModelProvider;
  validate(apiKey: string): Promise<void>;
}

/** Converts a failed credential probe into a provider-safe authentication error. */
async function validateResponse(provider: string, response: Response): Promise<void> {
  if (!response.ok)
    throw new Error(`${provider} credential validation failed (${response.status}).`);
}

export const providerRegistry: readonly ProviderDescriptor[] = [
  {
    id: "gemini",
    name: "Gemini",
    environmentVariable: "GEMINI_API_KEY",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "balanced", recommended: true },
    ],
    create: (apiKey, model, tools) => new GeminiProvider(apiKey, model, tools),
    validate: async (apiKey) =>
      validateResponse(
        "Gemini",
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
        ),
      ),
  },
  {
    id: "groq",
    name: "Groq",
    environmentVariable: "GROQ_API_KEY",
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tier: "strong", recommended: true },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (faster)", tier: "fast" },
    ],
    create: (apiKey, model, tools) => new GroqProvider(apiKey, model, tools),
    validate: async (apiKey) =>
      validateResponse(
        "Groq",
        await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      ),
  },
  {
    id: "mistral",
    name: "Mistral",
    environmentVariable: "MISTRAL_API_KEY",
    models: [
      {
        id: "mistral-small-latest",
        label: "Mistral Small 4",
        tier: "fast",
        recommended: true,
      },
      {
        id: "mistral-medium-latest",
        label: "Mistral Medium 3.5",
        tier: "strong",
      },
    ],
    create: (apiKey, model, tools) => new MistralProvider(apiKey, model, tools),
    validate: async (apiKey) =>
      validateResponse(
        "Mistral",
        await fetch("https://api.mistral.ai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      ),
  },
] as const;

/** Narrows untrusted CLI/config text to a registered provider identifier. */
export function isProviderId(value: unknown): value is ProviderId {
  return providerRegistry.some((provider) => provider.id === value);
}

/** Returns the registered behavior for one supported provider. */
export function providerById(id: ProviderId): ProviderDescriptor {
  return providerRegistry.find((provider) => provider.id === id)!;
}

/** Creates a provider from a validated global selection. */
export function createProvider(
  selection: ModelSelection,
  apiKey: string,
  tools: ToolDefinition[],
): ModelProvider {
  return providerById(selection.provider).create(apiKey, selection.model, tools);
}
