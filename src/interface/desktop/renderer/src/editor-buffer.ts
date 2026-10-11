import type { FileSnapshot } from "../../shared/api.js";
export type EditorBuffer = {
  draft: string;
  saved: string;
  revision: string;
  newline: "\n" | "\r\n";
  loadedAt: number;
};
export function editorBuffer(snapshot: FileSnapshot): EditorBuffer {
  const newline =
    snapshot.content.includes("\r\n") && !/(?<!\r)\n/.test(snapshot.content) ? "\r\n" : "\n";
  const text = snapshot.content.replace(/\r\n/g, "\n");
  return { draft: text, saved: text, revision: snapshot.revision, newline, loadedAt: Date.now() };
}
export function bufferContent(buffer: EditorBuffer): string {
  return buffer.newline === "\r\n" ? buffer.draft.replace(/\n/g, "\r\n") : buffer.draft;
}

export type EditorBuffers = Record<string, Record<string, EditorBuffer>>;
/** Keep every unsaved buffer, but bound complete clean-file copies across workspaces. */
export function retainBuffer(
  all: EditorBuffers,
  workspaceId: string,
  path: string,
  buffer: EditorBuffer,
): EditorBuffers {
  const next = { ...all, [workspaceId]: { ...all[workspaceId], [path]: buffer } };
  const clean = Object.entries(next)
    .flatMap(([id, files]) =>
      Object.entries(files)
        .filter(([, file]) => file.draft === file.saved)
        .map(([name, file]) => ({
          id,
          name,
          at: file.loadedAt,
          bytes: 2 * (file.draft.length + file.saved.length),
        })),
    )
    .sort((a, b) => a.at - b.at);
  let bytes = clean.reduce((sum, entry) => sum + entry.bytes, 0);
  let count = clean.length;
  for (const entry of clean) {
    if (count <= 20 && bytes <= 8 * 1024 * 1024) break;
    bytes -= entry.bytes;
    count -= 1;
    next[entry.id] = { ...next[entry.id] };
    delete next[entry.id][entry.name];
  }
  return next;
}
