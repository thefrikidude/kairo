import { ProviderError, type ProviderProgress } from "../../domain/provider-error.js";

/** Reads bounded nested SDK/HTTP error metadata without persisting any raw values. */
export function normalizeProviderError(error: unknown, provider = "Model provider"): ProviderError {
  if (error instanceof ProviderError) return error;
  const texts: string[] = [];
  const codes: string[] = [];
  let retryAfterMs: number | undefined;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || !value) return;
    if (typeof value === "string") {
      const text = value.slice(0, 16000);
      texts.push(text);
      try {
        visit(JSON.parse(text), depth + 1);
      } catch {
        /* SDK messages may be plain text. */
      }
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const field of ["code", "status", "statusCode", "name"])
      if (record[field] !== undefined) codes.push(String(record[field]));
    if (typeof record.retryDelay === "string") {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(record.retryDelay);
      if (match) retryAfterMs = Math.max(retryAfterMs ?? 0, Number(match[1]) * 1000);
    }
    const headers = record.headers as { get?: (key: string) => string | null } | undefined;
    const header =
      headers?.get?.("retry-after") ??
      (record.headers as Record<string, string> | undefined)?.["retry-after"];
    if (header) {
      const delay = /^\d+(?:\.\d+)?$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - Date.now();
      if (Number.isFinite(delay)) retryAfterMs = Math.max(retryAfterMs ?? 0, delay, 0);
    }
    for (const field of [
      "message",
      "error",
      "cause",
      "details",
      "response",
      "violations",
      "quotaId",
    ])
      visit(record[field], depth + 1);
    if (Array.isArray(value)) for (const item of value.slice(0, 20)) visit(item, depth + 1);
  };
  visit(error, 0);
  const text = texts.join(" ");
  const code = codes.join(" ");
  if (/\b(401|403|UNAUTHENTICATED|PERMISSION_DENIED)\b/.test(code))
    return new ProviderError(
      "authentication",
      false,
      undefined,
      provider,
      "Check the API key in /models.",
    );
  if (/\b(402|429|RESOURCE_EXHAUSTED)\b/.test(code)) {
    const permanent = /per.?day|daily|billing|credit/i.test(
      text.replace(/check your plan and billing details/gi, ""),
    );
    return new ProviderError(
      "quota",
      !permanent,
      retryAfterMs,
      provider,
      "Check the provider's credits, limits, or available model routes.",
    );
  }
  if (/\b(500|502|503|504|UNAVAILABLE|INTERNAL)\b/.test(code))
    return new ProviderError("service", true, retryAfterMs, provider);
  if (
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|TimeoutError|AbortError/.test(code) ||
    /fetch failed|network error|timed out/i.test(text)
  )
    return new ProviderError("network", true, retryAfterMs, provider);
  return new ProviderError(
    "request",
    false,
    undefined,
    provider,
    "Check that the selected model supports chat and tool calling.",
  );
}

export interface RecoveryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
const clock: RecoveryClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Retries only pre-content failures within three retries and 30 seconds of waiting. */
export async function recoverProvider<T>(
  request: (markContent: () => void) => Promise<T>,
  progress: (event: ProviderProgress) => void = () => {},
  timer: RecoveryClock = clock,
  provider = "Model provider",
  retryQuota = true,
): Promise<T> {
  let retries = 0;
  let waited = 0;
  for (;;) {
    let hasContent = false;
    try {
      return await request(() => {
        hasContent = true;
      });
    } catch (raw) {
      let error = normalizeProviderError(raw, provider);
      if (!retryQuota && error.category === "quota")
        error = new ProviderError(
          "quota",
          false,
          error.retryAfterMs,
          provider,
          "The provider quota was exhausted. Wait before trying again or use a provider with available capacity.",
        );
      const delay = error.retryAfterMs ?? 1000 * 2 ** retries + timer.random() * 250;
      if (!error.retryable || hasContent || retries >= 3 || delay > 30000 - waited) {
        progress({ kind: "exhausted", category: error.category, retry: retries, delayMs: 0 });
        throw error;
      }
      retries += 1;
      progress({ kind: "retry", category: error.category, retry: retries, delayMs: delay });
      const started = timer.now();
      await timer.sleep(delay);
      const elapsed = Math.max(delay, timer.now() - started);
      waited += elapsed;
      progress({ kind: "retry_wait", category: error.category, retry: retries, delayMs: elapsed });
    }
  }
}
