import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, isProviderId, providerById } from "./provider-registry.js";

test("OpenRouter is a supported provider with a free, tool-capable default", () => {
  assert.equal(isProviderId("openrouter"), true);
  assert.equal(providerById("openrouter").models[0]?.id, "qwen/qwen3.8-27b:free");
});

test("OpenRouter validates a key against its authenticated key endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInfo | URL | undefined;
  globalThis.fetch = async (input) => {
    request = input;
    return new Response(null, { status: 200 });
  };
  try {
    await providerById("openrouter").validate("or_test");
    assert.equal(String(request), "https://openrouter.ai/api/v1/key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Jev cannot be selected as Kairo's active coding model", () => {
  assert.throws(
    () => createProvider({ provider: "openrouter", model: "~typesafe/jev-latest" }, "or_test", []),
    /Jev is a decision model/,
  );
});
