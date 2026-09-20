import test from "node:test";
import assert from "node:assert/strict";
import { MistralProvider } from "./mistral-provider.js";
import { ProviderError } from "../../domain/provider-error.js";

function streamResponse(chunks: unknown[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Mistral streams text and reconstructs tool calls", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new MistralProvider(
    "mistral_test",
    "mistral-small-latest",
    [],
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([
        { choices: [{ delta: { content: "Inspecting " } }] },
        {
          choices: [
            {
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
    },
  );
  let text = "";
  const result = await provider.stream([], (chunk) => (text += chunk));
  assert.equal(text, "Inspecting ");
  assert.deepEqual(result.toolCalls, [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]);
  assert.equal(requestBody?.stream, true);
});

test("Mistral classifies authentication and quota responses safely", async () => {
  const auth = new MistralProvider(
    "mistral_test",
    "mistral-small-latest",
    [],
    async () => new Response(null, { status: 401 }),
  );
  await assert.rejects(
    auth.stream([], () => {}),
    (error: unknown) => error instanceof ProviderError && error.category === "authentication",
  );
});

test("Mistral omits tool definitions for a conversation response", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new MistralProvider(
    "mistral_test",
    "mistral-small-latest",
    [],
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([{ choices: [{ delta: { content: "Hello!" } }] }]);
    },
  );
  await provider.stream([], () => {}, undefined, "Answer directly.", false);
  assert.equal("tools" in requestBody!, false);
  assert.equal("tool_choice" in requestBody!, false);
});
