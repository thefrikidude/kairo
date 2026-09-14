import test from "node:test";
import assert from "node:assert/strict";
import { GroqProvider } from "./groq-provider.js";
import { ProviderError } from "../../domain/provider-error.js";

/** Creates a minimal Groq SSE response for transport-level provider tests. */
function streamResponse(chunks: unknown[]): Response {
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("Groq streams text, reconstructs tool calls, and sends durable tool history", async () => {
  const original = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}");
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    return streamResponse([
      { choices: [{ index: 0, delta: { content: "Inspecting " } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call-2", function: { name: "read_file", arguments: '{"pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
          },
        ],
      },
    ]);
  };
  try {
    let text = "";
    const provider = new GroqProvider("gsk_test", "openai/gpt-oss-120b", []);
    const result = await provider.stream(
      [
        {
          role: "model",
          content: '{"path":"old.ts"}',
          createdAt: 0,
          toolCallId: "call-1",
          toolName: "read_file",
        },
        {
          role: "tool",
          content: "old contents",
          createdAt: 1,
          toolCallId: "call-1",
          toolName: "read_file",
        },
      ],
      (chunk) => (text += chunk),
    );
    assert.equal(text, "Inspecting ");
    assert.deepEqual(result.toolCalls, [
      { id: "call-2", name: "read_file", args: { path: "a.ts" } },
    ]);
    assert.match(JSON.stringify(requestBody), /call-1/);
    assert.match(JSON.stringify(requestBody), /tool_call_id/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Groq rejects malformed streamed tool arguments without replaying content", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return streamResponse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "bad", function: { name: "read_file", arguments: "{" } },
              ],
            },
          },
        ],
      },
    ]);
  };
  try {
    await assert.rejects(
      new GroqProvider("gsk_test", "openai/gpt-oss-120b", []).stream([], () => {}),
      (error: unknown) => error instanceof ProviderError && error.category === "request",
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = original;
  }
});
