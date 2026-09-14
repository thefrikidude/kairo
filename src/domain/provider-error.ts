export type ProviderFailure = "quota" | "authentication" | "network" | "service" | "request";
export interface ProviderProgress {
  kind: "retry" | "retry_wait" | "exhausted";
  category: ProviderFailure;
  retry: number;
  delayMs: number;
}

/** Exposes only safe provider metadata; never retains the underlying error body. */
export class ProviderError extends Error {
  constructor(
    readonly category: ProviderFailure,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    provider = "Model provider",
  ) {
    super(`${provider} request failed (${category}).`);
    this.name = "ProviderError";
  }
}
