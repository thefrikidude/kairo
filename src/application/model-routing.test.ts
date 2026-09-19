import test from "node:test";
import assert from "node:assert/strict";
import { modelRoutingState, selectAutoModel, type AvailableModel } from "./model-routing.js";

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
