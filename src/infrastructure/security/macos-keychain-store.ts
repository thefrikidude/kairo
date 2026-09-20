import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialId } from "../../domain/models.js";
import type { CredentialStore } from "../../domain/ports.js";
const run = promisify(execFile);
const account = "default";
const services: Record<CredentialId, string> = {
  gemini: "dev.kairo.gemini",
  groq: "dev.kairo.groq",
  mistral: "dev.kairo.mistral",
  jev: "dev.kairo.jev",
};
const environment: Record<CredentialId, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  jev: "TYPESAFE_API_KEY",
};
type KeychainCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;

export class MacOSKeychainStore implements CredentialStore {
  constructor(
    private readonly command: KeychainCommand = run as unknown as KeychainCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Reads an environment override first, then the macOS Keychain credential. */
  async get(provider: CredentialId): Promise<string | undefined> {
    const override = this.env[environment[provider]];
    if (override) return override;
    try {
      return (
        (
          await this.command("security", [
            "find-generic-password",
            "-s",
            services[provider],
            "-a",
            account,
            "-w",
          ])
        ).stdout.trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  /** Saves a non-empty provider key in the macOS Keychain rather than local config. */
  async save(provider: CredentialId, value: string): Promise<void> {
    if (!value.trim()) throw new Error("API key cannot be empty.");
    await this.command("security", [
      "add-generic-password",
      "-U",
      "-s",
      services[provider],
      "-a",
      account,
      "-w",
      value.trim(),
    ]);
  }
  /** Removes Kairo's saved Keychain entry during logout. */
  async clear(provider: CredentialId): Promise<void> {
    try {
      await this.command("security", [
        "delete-generic-password",
        "-s",
        services[provider],
        "-a",
        account,
      ]);
    } catch {
      /* missing credential is already logged out */
    }
  }
}
