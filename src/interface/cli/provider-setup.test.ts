import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderId } from "../../domain/models.js";
import type { CredentialStore } from "../../domain/ports.js";
import { configureProvider, type ProviderSetupIO } from "./provider-setup.js";

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<ProviderId, string>();
  get(provider: ProviderId): Promise<string | undefined> {
    return Promise.resolve(this.values.get(provider));
  }
  async save(provider: ProviderId, value: string): Promise<void> {
    this.values.set(provider, value);
  }
  async clear(provider: ProviderId): Promise<void> {
    this.values.delete(provider);
  }
}

/** Supplies deterministic menu and secret answers without a real terminal. */
function setupIO(answers: string[], secrets: string[] = []): ProviderSetupIO {
  return {
    question: async () => answers.shift() ?? "",
    secret: async () => secrets.shift() ?? "",
    write: () => {},
  };
}

test("first-run setup validates and saves a missing provider credential", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const credentials = new MemoryCredentials();
    const selection = await configureProvider(setupIO(["2", "1"], ["gsk_secret"]), credentials);
    assert.deepEqual(selection, { provider: "groq", model: "openai/gpt-oss-120b" });
    assert.equal(await credentials.get("groq"), "gsk_secret");
    assert.equal(await credentials.get("gemini"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("logged-in users can select a custom model without re-entering a key", async () => {
  const credentials = new MemoryCredentials();
  await credentials.save("groq", "already-saved");
  const selection = await configureProvider(setupIO(["groq", "3", "custom/model"]), credentials, {
    provider: "gemini",
    model: "gemini-2.5-flash",
  });
  assert.deepEqual(selection, { provider: "groq", model: "custom/model" });
});

test("an existing selection can cancel provider switching", async () => {
  const credentials = new MemoryCredentials();
  assert.equal(
    await configureProvider(setupIO([""]), credentials, {
      provider: "gemini",
      model: "gemini-2.5-flash",
    }),
    undefined,
  );
});

test("invalid new credentials are not saved", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  try {
    const credentials = new MemoryCredentials();
    await assert.rejects(
      configureProvider(setupIO(["2", "1"], ["bad-key"]), credentials),
      /validation failed \(401\)/,
    );
    assert.equal(await credentials.get("groq"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});
