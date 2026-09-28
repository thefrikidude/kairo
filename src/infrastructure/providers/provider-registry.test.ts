import test from "node:test";
import assert from "node:assert/strict";
import { isProviderId, providerById } from "./provider-registry.js";

test("Mistral and OpenRouter are supported providers", () => {
  assert.equal(isProviderId("mistral"), true);
  assert.equal(isProviderId("openrouter"), true);
  assert.equal(providerById("mistral").models[0]?.id, "mistral-small-latest");
  assert.equal(providerById("openrouter").models[0]?.id, "openrouter/free");
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

test("OpenRouter validates a key against its current-key endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInfo | URL | undefined;
  let authorization: string | null | undefined;
  globalThis.fetch = async (input, init) => {
    request = input;
    authorization = new Headers(init?.headers).get("Authorization");
    return new Response(null, { status: 200 });
  };
  try {
    await providerById("openrouter").validate("or_test");
    assert.equal(String(request), "https://openrouter.ai/api/v1/key");
    assert.equal(authorization, "Bearer or_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
