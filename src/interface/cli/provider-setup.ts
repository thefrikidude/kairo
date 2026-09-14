import { execFileSync } from "node:child_process";
import type { createInterface } from "node:readline/promises";
import type { ModelSelection, ProviderId } from "../../domain/models.js";
import type { CredentialStore } from "../../domain/ports.js";
import {
  providerById,
  providerRegistry,
} from "../../infrastructure/providers/provider-registry.js";

export interface ProviderSetupIO {
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  write(message: string): void;
}

/** Wraps the shared REPL readline interface and disables terminal echo for secrets. */
export function terminalSetupIO(
  rl: ReturnType<typeof createInterface>,
  write: (message: string) => void = (message) => process.stdout.write(message),
): ProviderSetupIO {
  return {
    question: (prompt) => rl.question(prompt),
    async secret(prompt) {
      if (!process.stdin.isTTY) return rl.question(prompt);
      write(prompt);
      execFileSync("/bin/stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
      try {
        return await rl.question("");
      } finally {
        execFileSync("/bin/stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
        write("\n");
      }
    },
    write,
  };
}

/** Prompts until the user selects a registered provider or cancels an optional switch. */
async function chooseProvider(
  io: ProviderSetupIO,
  current?: ModelSelection,
): Promise<ProviderId | undefined> {
  io.write(
    `\nProviders:\n${providerRegistry
      .map((provider, index) => `  ${index + 1}. ${provider.name}`)
      .join("\n")}\n`,
  );
  for (;;) {
    const answer = (
      await io.question(current ? "Provider (blank to cancel): " : "Provider: ")
    ).trim();
    if (!answer && current) return undefined;
    const byNumber = providerRegistry[Number(answer) - 1];
    const byId = providerRegistry.find((provider) => provider.id === answer.toLowerCase());
    const selected = byNumber ?? byId;
    if (selected) return selected.id;
    io.write("Choose a listed provider by number or name.\n");
  }
}

/** Offers tested models first while retaining a custom-model escape hatch. */
async function chooseModel(io: ProviderSetupIO, providerId: ProviderId): Promise<string> {
  const provider = providerById(providerId);
  io.write(
    `\n${provider.name} models:\n${provider.models
      .map(
        (model, index) =>
          `  ${index + 1}. ${model.label}${model.recommended ? " (recommended)" : ""} — ${model.id}`,
      )
      .join("\n")}\n  ${provider.models.length + 1}. Custom model ID\n`,
  );
  for (;;) {
    const answer = (await io.question("Model: ")).trim();
    const index = Number(answer) - 1;
    if (provider.models[index]) return provider.models[index]!.id;
    if (index === provider.models.length) {
      const custom = (await io.question("Custom model ID: ")).trim();
      if (custom) return custom;
      io.write("Model ID cannot be empty.\n");
      continue;
    }
    io.write("Choose a listed model.\n");
  }
}

/** Collects and validates a provider/model selection, saving a missing credential by provider. */
export async function configureProvider(
  io: ProviderSetupIO,
  credentials: CredentialStore,
  current?: ModelSelection,
): Promise<ModelSelection | undefined> {
  const provider = await chooseProvider(io, current);
  if (!provider) return undefined;
  const model = await chooseModel(io, provider);
  const descriptor = providerById(provider);
  let key = await credentials.get(provider);
  if (!key) {
    key = (await io.secret(`${descriptor.name} API key (saved in macOS Keychain): `)).trim();
    if (!key) throw new Error("API key cannot be empty.");
    await descriptor.validate(key);
    await credentials.save(provider, key);
  }
  return { provider, model };
}
