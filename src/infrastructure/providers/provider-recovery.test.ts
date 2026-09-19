import test from "node:test";
import assert from "node:assert/strict";
import {
  recoverProvider,
  normalizeProviderError,
  type RecoveryClock,
} from "./provider-recovery.js";
import { ProviderError, type ProviderProgress } from "../../domain/provider-error.js";

/** Provides deterministic virtual retry time. */
function timer(): RecoveryClock {
  let now = 0;
  return {
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
  };
}
test("temporary failures recover with bounded virtual backoff and separate wait events", async () => {
  let calls = 0;
  const events: ProviderProgress[] = [];
  const result = await recoverProvider(
    async () => {
      if (++calls < 3) throw { status: 503, message: "secret" };
      return "ok";
    },
    (event) => events.push(event),
    timer(),
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(
    events.filter((event) => event.kind === "retry_wait").map((event) => event.delayMs),
    [1000, 2000],
  );
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});
test("three retries are the maximum and required delays beyond budget stop immediately", async () => {
  for (const delay of [undefined, 31000, 15000]) {
    let calls = 0;
    await assert.rejects(
      recoverProvider(
        async () => {
          calls++;
          throw new ProviderError("quota", true, delay);
        },
        undefined,
        timer(),
      ),
      ProviderError,
    );
    assert.equal(calls, delay === undefined ? 4 : delay === 31000 ? 1 : 3);
  }
});
test("authentication, request and daily quota errors never retry", async () => {
  for (const error of [
    { status: 401 },
    { status: 400 },
    { status: 429, message: "Daily quota exhausted" },
  ]) {
    let calls = 0;
    await assert.rejects(
      recoverProvider(
        async () => {
          calls++;
          throw error;
        },
        undefined,
        timer(),
      ),
      ProviderError,
    );
    assert.equal(calls, 1);
  }
});

test("free-model quota errors do not spend the allowance on automatic retries", async () => {
  let calls = 0;
  await assert.rejects(
    recoverProvider(
      async () => {
        calls++;
        throw { status: 429 };
      },
      undefined,
      timer(),
      "OpenRouter",
      false,
    ),
    (error: unknown) =>
      error instanceof ProviderError &&
      /free-model rate limit was reached/.test(error.message) &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});
test("received text or function-call content prevents replay", async () => {
  let calls = 0;
  await assert.rejects(
    recoverProvider(
      async (markContent) => {
        calls++;
        markContent();
        throw { code: "ECONNRESET" };
      },
      undefined,
      timer(),
    ),
    ProviderError,
  );
  assert.equal(calls, 1);
});
test("normalization reads nested Gemini retry hints and never retains raw bodies", () => {
  const normalized = normalizeProviderError({
    status: 429,
    message: JSON.stringify({
      error: { details: [{ retryDelay: "12.5s" }], message: "sensitive credentials" },
    }),
  });
  assert.equal(normalized.retryAfterMs, 12500);
  assert.equal(normalized.retryable, true);
  assert.doesNotMatch(JSON.stringify(normalized), /sensitive|credentials/);
  assert.equal(
    normalizeProviderError({ status: 503, headers: { "retry-after": "5" } }).retryAfterMs,
    5000,
  );
  assert.equal(normalizeProviderError(new TypeError("fetch failed")).category, "network");
});

test("OpenRouter-style billing and request failures expose safe next steps", () => {
  const credit = normalizeProviderError(
    { status: 402, message: "private provider body" },
    "OpenRouter",
  );
  assert.equal(credit.category, "quota");
  assert.match(credit.message, /credits, limits, or available model routes/);
  assert.doesNotMatch(credit.message, /private provider body/);

  const request = normalizeProviderError(
    { status: 400, message: "private provider body" },
    "OpenRouter",
  );
  assert.equal(request.category, "request");
  assert.match(request.message, /supports chat and tool calling/);
  assert.doesNotMatch(request.message, /private provider body/);
});
