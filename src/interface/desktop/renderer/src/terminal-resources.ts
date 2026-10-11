import type { TerminalData } from "../../shared/api.js";
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;
/** One observer for the application theme, independent of terminal count. */
export function observeTerminalTheme(callback: () => void): () => void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const update of themeListeners) update();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  themeListeners.add(callback);
  return () => {
    themeListeners.delete(callback);
    if (!themeListeners.size) {
      themeObserver?.disconnect();
      themeObserver = undefined;
    }
  };
}
const outputListeners = new Map<string, (packet: TerminalData) => void>();
let unsubscribeOutput: (() => void) | undefined;
/** Dispatch terminal data once instead of crossing the preload bridge once per mounted terminal. */
export function subscribeTerminalOutput(
  id: string,
  callback: (packet: TerminalData) => void,
): () => void {
  if (!unsubscribeOutput)
    unsubscribeOutput = window.kairo.onTerminalData((packet) =>
      outputListeners.get(packet.id)?.(packet),
    );
  outputListeners.set(id, callback);
  return () => {
    if (outputListeners.get(id) === callback) outputListeners.delete(id);
    if (!outputListeners.size) {
      unsubscribeOutput?.();
      unsubscribeOutput = undefined;
    }
  };
}
