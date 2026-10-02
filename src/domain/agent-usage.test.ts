import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsage, selectUsageBucket, usageWindowLabel } from "./agent-usage.js";

test("Codex usage prefers multiple buckets, clamps remaining values and preserves unknown fields", () => {
  const snapshot = parseCodexUsage({
    rateLimits: { limitId: "codex", primary: { usedPercent: 30 } },
    rateLimitsByLimitId: {
      codex: {
        limitName: "Shared quota",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, windowDurationMins: 10080 },
      },
      special: {
        normalModelSlug: "model-a",
        primary: { usedPercent: -10, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 140 },
      },
      missing: { primary: null, secondary: { usedPercent: null } },
    },
  });
  assert.equal(snapshot.buckets.length, 3);
  assert.equal(selectUsageBucket(snapshot, "model-a")?.id, "special");
  assert.equal(selectUsageBucket(snapshot, "model-not-associated")?.id, "codex");
  const shared = snapshot.buckets[0];
  assert.equal(shared.label, "Shared quota");
  assert.equal(shared.windows[0].remainingPercent, 75);
  assert.equal(shared.windows[1].remainingPercent, 0);
  assert.equal(usageWindowLabel(shared.windows[0]), "5h");
  assert.equal(usageWindowLabel(shared.windows[1]), "Weekly");
  assert.deepEqual(
    snapshot.buckets[1].windows.map((window) => window.remainingPercent),
    [100, 0],
  );
  assert.equal(usageWindowLabel(snapshot.buckets[1].windows[0]), "Quota");
  assert.equal(snapshot.buckets[1].windows[0].resetsAt, undefined);
  assert.deepEqual(snapshot.buckets[2].windows, []);
});

test("Codex usage supports the legacy response without inventing percentages or model mappings", () => {
  const legacy = parseCodexUsage({
    rateLimits: { primary: { usedPercent: 42, windowDurationMins: 15 } },
  });
  assert.equal(legacy.defaultBucketId, "codex");
  assert.equal(legacy.buckets[0].windows[0].remainingPercent, 58);
  assert.equal(usageWindowLabel(legacy.buckets[0].windows[0]), "15m");
  assert.deepEqual(parseCodexUsage({ rateLimits: null }).buckets, []);
  assert.deepEqual(
    parseCodexUsage({
      rateLimits: { primary: { usedPercent: NaN }, secondary: { usedPercent: Infinity } },
    }).buckets[0].windows,
    [],
  );
  assert.equal(
    selectUsageBucket({ buckets: [{ id: "unknown", label: "Unknown", windows: [] }] }, "model"),
    undefined,
  );
});
