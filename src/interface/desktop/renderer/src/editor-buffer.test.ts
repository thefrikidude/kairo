import test from "node:test";
import assert from "node:assert/strict";
import { bufferContent, editorBuffer } from "./editor-buffer.js";
test("editable buffers preserve BOM and consistent CRLF line endings", () => {
  const buffer = editorBuffer({ content: "\ufefffirst\r\nsecond\r\n", revision: "revision" });
  assert.equal(buffer.draft, "\ufefffirst\nsecond\n");
  assert.equal(
    bufferContent({ ...buffer, draft: `${buffer.draft}third\n` }),
    "\ufefffirst\r\nsecond\r\nthird\r\n",
  );
});

test("buffer caching bounds clean copies while retaining every unsaved file", async () => {
  const { retainBuffer } = await import("./editor-buffer.js");
  let buffers: import("./editor-buffer.js").EditorBuffers = {};
  const dirty = {
    ...editorBuffer({ content: "original", revision: "revision" }),
    draft: "unsaved",
  };
  buffers = retainBuffer(buffers, "old-workspace", "unsaved.ts", dirty);
  for (let index = 0; index < 30; index += 1)
    buffers = retainBuffer(
      buffers,
      "current-workspace",
      `file${index}.ts`,
      editorBuffer({ content: "clean", revision: "revision" }),
    );
  assert.equal(Object.keys(buffers["current-workspace"]).length, 20);
  assert.equal(buffers["old-workspace"]["unsaved.ts"].draft, "unsaved");
});

test("clean buffer cache obeys its byte budget and never evicts dirty buffers", async () => {
  const { retainBuffer } = await import("./editor-buffer.js");
  const large = "x".repeat(1024 * 1024);
  let buffers: import("./editor-buffer.js").EditorBuffers = {};
  buffers = retainBuffer(buffers, "dirty", "unsaved", {
    ...editorBuffer({ content: large, revision: "old" }),
    draft: large + "edit",
  });
  for (let index = 0; index < 4; index++)
    buffers = retainBuffer(buffers, "clean", String(index), {
      ...editorBuffer({ content: large, revision: String(index) }),
      loadedAt: index,
    });
  assert.deepEqual(Object.keys(buffers.clean), ["2", "3"]);
  assert.equal(buffers.dirty.unsaved.draft, large + "edit");
});
