import test from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "./gemini-provider.js";
import { ProviderError } from "../../domain/provider-error.js";

test("Gemini transport preserves HTTP quota status and retry hints without hidden retries", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "temporary limit",
          details: [{ retryDelay: "31s" }],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const provider = new GeminiProvider("fake-key", "gemini-2.5-flash", []);
    await assert.rejects(
      provider.stream([{ role: "user", content: "test", createdAt: 0 }], () => {}),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.category === "quota" &&
        error.retryAfterMs === 31000,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});
