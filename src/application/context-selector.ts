import type { RepositoryProfile } from "../domain/models.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "with",
  "this",
  "that",
  "from",
  "into",
  "add",
  "fix",
  "make",
  "code",
  "file",
]);

export class ContextSelector {
  select(task: string, profile: RepositoryProfile, limit = 12): string[] {
    const terms = task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
    return profile.indexedFiles
      .map((path) => ({ path, score: this.score(path, terms, profile) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((item) => item.path);
  }
  private score(path: string, terms: string[], profile: RepositoryProfile): number {
    const lower = path.toLowerCase();
    const termScore = terms.reduce((score, term) => score + (lower.includes(term) ? 4 : 0), 0);
    const sourceScore = profile.sourceRoots.some((root) => lower.startsWith(`${root}/`)) ? 1 : 0;
    const testScore = profile.testRoots.some((root) => lower.startsWith(`${root}/`)) ? 1 : 0;
    return termScore + sourceScore + testScore;
  }
}
