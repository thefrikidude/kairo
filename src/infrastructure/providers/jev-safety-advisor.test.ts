import test from "node:test";
import assert from "node:assert/strict";
import { JevDecisionProvider } from "./jev-safety-advisor.js";
import { ProviderError } from "../../domain/provider-error.js";

test("Jev sends one typed, bounded risk decision and parses the safe answer", async () => {
  let request: Request | undefined;
  const provider = new JevDecisionProvider("ts_secret", async (input, init) => {
    request = new Request(input, init);
    return new Response(
      JSON.stringify({ answers: { action_risk: { choice: "high", confidence: 0.92 } } }),
      { status: 200 },
    );
  });
  assert.deepEqual(await provider.assess("x".repeat(5_000)), { risk: "high", confidence: 0.92 });
  assert.equal(request?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(request?.headers.get("authorization"), "Bearer ts_secret");
  const body = (await request?.json()) as Record<string, unknown>;
  assert.equal(body.model, "jev-latest");
  assert.equal(String(body.state).length, 4_000);
  assert.deepEqual(Object.keys(body.questions as object), ["action_risk"]);
});

test("Jev rejects malformed decisions and classifies authentication failures", async () => {
  await assert.rejects(
    new JevDecisionProvider("key", async () => new Response("{}", { status: 200 })).assess("state"),
    ProviderError,
  );
  await assert.rejects(
    new JevDecisionProvider("key", async () => new Response(null, { status: 401 })).assess("state"),
    (error: unknown) => error instanceof ProviderError && error.category === "authentication",
  );
});

test("Jev serializes typed route and recovery decisions independently", async () => {
  const questions: string[] = [];
  const provider = new JevDecisionProvider("key", async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const question = Object.keys(body.questions)[0]!;
    questions.push(question);
    const choice = question === "task_route" ? "plan" : "escalate";
    return new Response(JSON.stringify({ answers: { [question]: { choice, confidence: 0.9 } } }));
  });
  assert.deepEqual(await provider.route("broad architecture task"), {
    value: "plan",
    confidence: 0.9,
  });
  assert.deepEqual(await provider.recover("failed check metadata"), {
    value: "escalate",
    confidence: 0.9,
  });
  assert.deepEqual(questions, ["task_route", "verification_recovery"]);
});
