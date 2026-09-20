import test from "node:test";
import assert from "node:assert/strict";
import { isProviderId, providerById } from "./provider-registry.js";

test("Mistral is a supported provider with a tool-capable default", () => {
  assert.equal(isProviderId("mistral"), true);
  assert.equal(isProviderId("openrouter"), false);
  assert.equal(providerById("mistral").models[0]?.id, "mistral-small-latest");
});

test("Mistral validates a key against its models endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInfo | URL | undefined;
  globalThis.fetch = async (input) => {
    request = input;
    return new Response(null, { status: 200 });
  };
  try {
    await providerById("mistral").validate("mistral_test");
    assert.equal(String(request), "https://api.mistral.ai/v1/models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
