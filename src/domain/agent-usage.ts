/** Account quotas reported by an agent; these are independent of any chat's token count. */
export type UsageWindow = { remainingPercent: number; durationMinutes?: number; resetsAt?: number };
export type UsageBucket = {
  id: string;
  label: string;
  model?: string;
  windows: UsageWindow[];
};
export type UsageSnapshot = { buckets: UsageBucket[]; defaultBucketId?: string };
export type UsageChange = "limits" | "account" | "disconnected";
export type AgentUsage = UsageSnapshot & {
  agentId: string;
  revision: number;
  status: "loading" | "available" | "unavailable" | "stale";
  updatedAt?: number;
  error?: string;
};

function bucket(value: unknown, fallbackId: string): UsageBucket | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.limitId === "string" && raw.limitId ? raw.limitId : fallbackId;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = raw[key] as Record<string, unknown> | undefined;
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent))
      continue;
    windows.push({
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      durationMinutes:
        typeof window.windowDurationMins === "number" &&
        Number.isFinite(window.windowDurationMins) &&
        window.windowDurationMins > 0
          ? window.windowDurationMins
          : undefined,
      resetsAt:
        typeof window.resetsAt === "number" &&
        Number.isFinite(window.resetsAt) &&
        window.resetsAt > 0
          ? window.resetsAt
          : undefined,
    });
  }
  return {
    id,
    label: typeof raw.limitName === "string" && raw.limitName ? raw.limitName : id,
    model: typeof raw.normalModelSlug === "string" ? raw.normalModelSlug : undefined,
    windows,
  };
}

export function parseCodexUsage(value: unknown): UsageSnapshot {
  if (!value || typeof value !== "object") throw new Error("Codex usage data is unavailable.");
  const raw = value as Record<string, unknown>;
  const legacy = bucket(raw.rateLimits, "codex");
  const buckets = new Map<string, UsageBucket>();
  const multiple = raw.rateLimitsByLimitId;
  if (multiple && typeof multiple === "object" && !Array.isArray(multiple)) {
    for (const [id, item] of Object.entries(multiple)) {
      const parsed = bucket(item, id);
      if (parsed) buckets.set(parsed.id, parsed);
    }
  }
  if (legacy && !buckets.has(legacy.id)) buckets.set(legacy.id, legacy);
  return { buckets: [...buckets.values()], defaultBucketId: legacy?.id };
}

export function selectUsageBucket(
  snapshot: UsageSnapshot,
  model?: string,
): UsageBucket | undefined {
  return (
    (model
      ? snapshot.buckets.find((bucket) => bucket.model === model || bucket.id === model)
      : undefined) ?? snapshot.buckets.find((bucket) => bucket.id === snapshot.defaultBucketId)
  );
}

export function usageWindowLabel(window: UsageWindow): string {
  const minutes = window.durationMinutes;
  if (!minutes) return "Quota";
  if (minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
