import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialStore } from "../../domain/ports.js";
const run = promisify(execFile);
const service = "dev.kairo.gemini";
const account = "default";

export class MacOSKeychainStore implements CredentialStore {
  /** Reads an environment override first, then the macOS Keychain credential. */
  async get(): Promise<string | undefined> {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    try {
      return (
        (
          await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"])
        ).stdout.trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  /** Saves a non-empty Gemini key in the macOS Keychain rather than local config. */
  async save(value: string): Promise<void> {
    if (!value.trim()) throw new Error("API key cannot be empty.");
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      value.trim(),
    ]);
  }
  /** Removes Kairo's saved Keychain entry during logout. */
  async clear(): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch {
      /* missing credential is already logged out */
    }
  }
}
