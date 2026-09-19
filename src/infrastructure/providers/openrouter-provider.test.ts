import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider } from "./openrouter-provider.js";

function streamResponse(chunks: unknown[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("OpenRouter streams text and reconstructs tool calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    streamResponse([
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen/qwen3.8-27b:free",
        choices: [{ index: 0, finish_reason: null, delta: { content: "Inspecting " } }],
      },
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen/qwen3.8-27b:free",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
          },
        ],
      },
    ]);
  try {
    let text = "";
    const result = await new OpenRouterProvider("or_test", "qwen/qwen3.8-27b:free", []).stream(
      [],
      (chunk) => (text += chunk),
    );
    assert.equal(text, "Inspecting ");
    assert.deepEqual(result.toolCalls, [
      { id: "call-1", name: "read_file", args: { path: "a.ts" } },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
