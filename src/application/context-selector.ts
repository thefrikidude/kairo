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
  /** Returns the highest-scoring repository files for a task or verification failure. */
  select(task: string, profile: RepositoryProfile, limit = 12): string[] {
    const terms = this.terms(task);
    const files = profile.files?.length
      ? profile.files
      : profile.indexedFiles.map((path) => ({
          path,
          terms: [],
          symbols: [],
          imports: [],
          relatedFiles: [],
        }));
    const direct = new Set(
      files.filter((file) => this.directScore(file, terms, profile) > 0).map((file) => file.path),
    );
    // Relationship proximity only boosts files that are connected to independently relevant files.
    return files
      .map((file) => ({ path: file.path, score: this.score(file, terms, profile, direct) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((item) => item.path);
  }
  /** Produces normal and camel-case-split query terms for code identifiers. */
  private terms(value: string): string[] {
    return [value, value.replace(/([a-z])([A-Z])/g, "$1 $2")]
      .flatMap((part) => part.toLowerCase().split(/[^a-z0-9_$]+/))
      .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
  }
  /** Adds graph proximity to a file's direct lexical and structural relevance. */
  private score(
    file: { path: string; terms: string[]; symbols: string[]; relatedFiles: string[] },
    terms: string[],
    profile: RepositoryProfile,
    direct: Set<string>,
  ): number {
    const relationshipScore = file.relatedFiles.some((path) => direct.has(path)) ? 3 : 0;
    return this.directScore(file, terms, profile) + relationshipScore;
  }
  /** Scores paths, file text, symbols, and source/test roles independently. */
  private directScore(
    file: { path: string; terms: string[]; symbols: string[] },
    terms: string[],
    profile: RepositoryProfile,
  ): number {
    const lower = file.path.toLowerCase();
    const pathScore = terms.reduce((score, term) => score + (lower.includes(term) ? 4 : 0), 0);
    const contentScore = terms.reduce(
      (score, term) => score + (file.terms.includes(term) ? 3 : 0),
      0,
    );
    const symbolScore = terms.reduce(
      (score, term) => score + (file.symbols.includes(term) ? 6 : 0),
      0,
    );
    const sourceScore = profile.sourceRoots.some((root) => lower.startsWith(`${root}/`)) ? 1 : 0;
    const testScore = profile.testRoots.some((root) => lower.startsWith(`${root}/`)) ? 1 : 0;
    return pathScore + contentScore + symbolScore + sourceScore + testScore;
  }
}
