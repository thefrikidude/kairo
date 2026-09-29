import test from "node:test";
import assert from "node:assert/strict";
import {
  executeInteraction,
  greetingResponse,
  interactionIntentState,
  routeInteraction,
} from "./interaction-routing.js";
import type { CodingAgent } from "./coding-agent.js";
import type { Message } from "../domain/models.js";

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

test("the shared router keeps greetings local and skips Jev", async () => {
  let called = false;
  const route = await routeInteraction("Hello", "build", false, {
    async intent() {
      called = true;
      return { value: "repository_task", confidence: 1 };
    },
  });
  assert.deepEqual(route, {
    intent: "conversation",
    mode: "answer",
    localResponse: "Hello! What would you like to inspect, plan, change, or verify?",
  });
  assert.equal(called, false);
});

test("the shared router directs Jev answers to the tool-free answer path", async () => {
  const route = await routeInteraction("What is Kairo?", "build", true, {
    async intent() {
      return { value: "answer", confidence: 0.92 };
    },
  });
  assert.deepEqual(route, { intent: "answer", mode: "answer" });
});

test("Jev-classified casual conversation gets a local response", async () => {
  const route = await routeInteraction("How are you?", "build", false, {
    async intent() {
      return { value: "conversation", confidence: 0.95 };
    },
  });
  assert.deepEqual(route, {
    intent: "conversation",
    mode: "answer",
    localResponse: "I'm here and ready to help. What would you like to work on?",
  });
});

test("uncertain or unavailable intent routing safely preserves repository task handling", async () => {
  const uncertain = await routeInteraction("Fix the parser", "build", true, {
    async intent() {
      return { value: "answer", confidence: 0.5 };
    },
  });
  const unavailable = await routeInteraction("Fix the parser", "build", true, {
    async intent() {
      throw new Error("Jev unavailable");
    },
  });
  assert.deepEqual(uncertain, { intent: "repository_task", mode: "build" });
  assert.deepEqual(unavailable, uncertain);
});

test("explicit plan mode remains plan when automatic routing is disabled", async () => {
  const route = await routeInteraction("Inspect the design", "plan", false, {
    async intent() {
      throw new Error("Must not classify explicit plan mode");
    },
  });
  assert.deepEqual(route, { intent: "repository_task", mode: "plan" });
});

test("shared interaction execution persists local greetings without creating an agent", async () => {
  const route = await routeInteraction("Hello", "build", false);
  const saved: Array<{ role: string; content: string }> = [];
  const streamed: string[] = [];
  await executeInteraction(
    route,
    "session-1",
    "Hello",
    {
      addMessage(_sessionId: string, message: Message) {
        saved.push(message);
      },
    } as never,
    undefined,
    (text) => streamed.push(text),
  );
  assert.deepEqual(
    saved.map(({ role, content }) => [role, content]),
    [
      ["user", "Hello"],
      ["model", route.localResponse],
    ],
  );
  assert.deepEqual(streamed, [route.localResponse]);
});

test("shared interaction execution dispatches general answers without starting a task", async () => {
  const route = { intent: "answer" as const, mode: "answer" as const };
  const calls: string[] = [];
  const agent = {
    async answer() {
      calls.push("answer");
    },
    async plan() {
      calls.push("plan");
    },
    async run() {
      calls.push("build");
    },
  } as unknown as CodingAgent;
  await executeInteraction(
    route,
    "session-1",
    "Explain this",
    { addMessage() {} } as never,
    agent,
    () => {},
  );
  assert.deepEqual(calls, ["answer"]);
});

test("shared interaction execution dispatches plan and build routes consistently", async () => {
  const calls: string[] = [];
  const agent = {
    async answer() {
      calls.push("answer");
    },
    async plan() {
      calls.push("plan");
    },
    async run() {
      calls.push("build");
    },
  } as unknown as CodingAgent;
  const store = { addMessage() {} } as never;
  await executeInteraction(
    { intent: "repository_task", mode: "plan" },
    "session-1",
    "Plan this",
    store,
    agent,
    () => {},
  );
  await executeInteraction(
    { intent: "repository_task", mode: "build" },
    "session-1",
    "Build this",
    store,
    agent,
    () => {},
  );
  assert.deepEqual(calls, ["plan", "build"]);
});
