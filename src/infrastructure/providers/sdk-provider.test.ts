import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderId } from "../../domain/models.js";
import type { ToolDefinition } from "../../domain/ports.js";
import { ProviderError } from "../../domain/provider-error.js";
import { SdkProvider } from "./sdk-provider.js";

const tool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  mutating: false,
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function openAiStream(): Response {
  return new Response(
    [
      'data: {"choices":[{"index":0,"delta":{"content":"Inspecting "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("shared provider adapter streams text and tool calls for OpenAI-compatible providers", async () => {
  for (const provider of ["groq", "mistral", "openrouter"] as const) {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = new SdkProvider(provider, "test-key", "test-model", [tool], {
      fetcher: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = (await request.clone().json()) as Record<string, unknown>;
        return openAiStream();
      },
    });
    let streamed = "";
    const turn = await adapter.stream(
      [
        {
          role: "model",
          content: '{"path":"prior.ts"}',
          createdAt: 1,
          toolCallId: "prior-call",
          toolName: "read_file",
        },
        {
          role: "tool",
          content: "prior contents",
          createdAt: 2,
          toolCallId: "prior-call",
          toolName: "read_file",
        },
      ],
      (chunk) => (streamed += chunk),
    );

    assert.equal(streamed, "Inspecting ", provider);
    assert.deepEqual(turn.toolCalls, [
      { id: "call-1", name: "read_file", args: { path: "a.ts" } },
    ]);
    assert.match(JSON.stringify(requestBody), /prior-call/);
    assert.match(JSON.stringify(requestBody), /prior contents/);
  }
});

test("Gemini SDK adapter streams content and sends system instructions", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new SdkProvider("gemini", "test-key", "gemini-test", [], {
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestBody = (await request.clone().json()) as Record<string, unknown>;
      return new Response(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let streamed = "";
  const turn = await adapter.stream(
    [{ role: "user", content: "Hi", createdAt: 0 }],
    (chunk) => (streamed += chunk),
    undefined,
    "Answer directly.",
    false,
  );
  assert.equal(streamed, "Hello");
  assert.deepEqual(turn, { text: "Hello", toolCalls: [] });
  assert.equal(requestBody?.systemInstruction !== undefined, true);
  assert.equal(requestBody?.tools, undefined);
});

test("shared adapter disables SDK retries so Kairo recovery sees provider status", async () => {
  let requests = 0;
  const provider: ProviderId = "gemini";
  const adapter = new SdkProvider(provider, "test-key", "gemini-test", [], {
    fetcher: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { code: 429, message: "temporary limit" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    },
  });
  await assert.rejects(
    adapter.stream([{ role: "user", content: "Hi", createdAt: 0 }], () => {}),
    (error: unknown) => error instanceof ProviderError && error.category === "quota",
  );
  assert.equal(requests, 1);
});
