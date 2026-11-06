import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

// Build output and dependencies churn constantly and are never reviewed as agent edits.
const ignoredSegments = new Set([".git", "node_modules"]);

/**
 * Remembers which agent sessions were working when each file changed. This is attribution by
 * timing, not by process: when two agents are mid-turn at once, a touch is credited to both.
 */
export class ChangeAttribution {
  private readonly touches = new Map<string, Set<string>>();

  constructor(private readonly limit = 5_000) {}

  record(path: string, sessionIds: readonly string[]): void {
    if (!sessionIds.length) return;
    const sessions = this.touches.get(path) ?? new Set<string>();
    // Re-insert so the least recently touched paths are the ones evicted at the limit.
    this.touches.delete(path);
    for (const id of sessionIds) sessions.add(id);
    this.touches.set(path, sessions);
    if (this.touches.size > this.limit) this.touches.delete(this.touches.keys().next().value!);
  }

  sessionsFor(path: string): string[] {
    return [...(this.touches.get(path) ?? [])];
  }
}

/** Watches one workspace directory and credits every file change to the sessions working then. */
export class ChangeTracker {
  private watcher?: FSWatcher;

  constructor(
    private readonly directory: string,
    private readonly working: () => string[],
    readonly attribution = new ChangeAttribution(),
  ) {}

  get running(): boolean {
    return !!this.watcher;
  }

  /** Returns false when the platform cannot watch this directory; tracking is then unavailable. */
  start(): boolean {
    if (this.watcher) return true;
    try {
      this.watcher = watch(this.directory, { recursive: true, persistent: false }, (_, name) => {
        if (!name) return;
        const parts = name.toString().split(sep);
        if (parts.some((part) => ignoredSegments.has(part))) return;
        this.attribution.record(parts.join("/"), this.working());
      });
      this.watcher.on("error", () => this.stop());
      return true;
    } catch {
      this.watcher = undefined;
      return false;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
