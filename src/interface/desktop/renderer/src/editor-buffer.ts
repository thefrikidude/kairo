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
        .map(([name, file]) => ({ id, name, at: file.loadedAt })),
    )
    .sort((a, b) => a.at - b.at);
  for (const entry of clean.slice(0, Math.max(0, clean.length - 20))) {
    next[entry.id] = { ...next[entry.id] };
    delete next[entry.id][entry.name];
  }
  return next;
}
