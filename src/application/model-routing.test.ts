import test from "node:test";
import assert from "node:assert/strict";
import {
  modelRoutingState,
  quotaFallbackModels,
  selectAutoModel,
  type AvailableModel,
} from "./model-routing.js";

const models: AvailableModel[] = [
  { provider: "groq", model: "fast", tier: "fast", apiKey: "key" },
  { provider: "groq", model: "strong", tier: "strong", apiKey: "key" },
];

test("auto model routing honors the tier and falls back to the manual model", () => {
  assert.equal(
    selectAutoModel(models, { provider: "groq", model: "strong" }, "fast")?.model,
    "fast",
  );
  assert.equal(
    selectAutoModel(models, { provider: "groq", model: "strong" }, "balanced")?.model,
    "strong",
  );
});

test("model routing state excludes credential values", () => {
  const state = modelRoutingState("Fix a small bug", models);
  assert.match(state, /groq\/fast=fast/);
  assert.doesNotMatch(state, /apiKey|key/);
});

test("quota fallback prefers another provider before another model on the exhausted provider", () => {
  const available: AvailableModel[] = [
    { provider: "mistral", model: "small", tier: "fast", apiKey: "key" },
    { provider: "mistral", model: "medium", tier: "strong", apiKey: "key" },
    { provider: "groq", model: "fast", tier: "fast", apiKey: "key" },
  ];
  assert.deepEqual(
    quotaFallbackModels(
      available,
      { provider: "mistral", model: "small" },
      { provider: "mistral", model: "small" },
      "fast",
    ).map((candidate) => `${candidate.provider}/${candidate.model}`),
    ["groq/fast", "mistral/medium"],
  );
});
