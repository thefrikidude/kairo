import type { RepositoryFingerprint, RepositorySnapshot } from "../../domain/models.js";
import type { TaskStore } from "../../domain/ports.js";
import { RepositoryProfiler } from "./repository-profiler.js";

export class RepositoryAwareness {
  constructor(
    private readonly store: TaskStore,
    private readonly profiler = new RepositoryProfiler(),
  ) {}

  /** Reuses a current snapshot or atomically replaces stale derived metadata. */
  async ensureFresh(sessionId: string, root: string): Promise<RepositorySnapshot> {
    const saved = this.store.repositorySnapshot(sessionId);
    const current = await this.fingerprint(root);
    if (saved?.fingerprint.value === current.value) return saved;
    const snapshot = await this.build(root);
    this.store.saveRepositorySnapshot(sessionId, snapshot);
    return snapshot;
  }

  build(root: string): Promise<RepositorySnapshot> {
    return this.profiler.profile(root);
  }

  fingerprint(root: string): Promise<RepositoryFingerprint> {
    return this.profiler.fingerprint(root);
  }
}
