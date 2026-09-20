import test from "node:test";
import assert from "node:assert/strict";
import {
  autoInteractionMode,
  greetingResponse,
  interactionIntentState,
} from "./interaction-routing.js";

test("obvious greetings stay local and do not need an agent decision", () => {
  assert.equal(
    greetingResponse("Hello"),
    "Hello! What would you like to inspect, plan, change, or verify?",
  );
  assert.equal(greetingResponse("thanks!"), "You're welcome. What would you like to work on?");
  assert.equal(greetingResponse("Explain this error"), undefined);
});

test("interaction intent state redacts likely credential values", () => {
  const state = interactionIntentState("hello sk_abcdefghijklmnopqrstuvwxyz");
  assert.match(state, /\[redacted\]/);
  assert.doesNotMatch(state, /abcdefghijklmnopqrstuvwxyz/);
});

test("AUTO changes modes only after classifying the interaction", () => {
  assert.equal(autoInteractionMode("conversation"), "plan");
  assert.equal(autoInteractionMode("answer"), "plan");
  assert.equal(autoInteractionMode("repository_task"), "build");
});
