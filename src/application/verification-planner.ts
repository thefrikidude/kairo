import type { RepositoryProfile, VerificationCandidate } from "../domain/models.js";

const labels: Array<[VerificationCandidate["label"], string[]]> = [
  ["test", ["test", "test:unit", "test:run"]],
  ["typecheck", ["typecheck", "type-check", "check"]],
  ["lint", ["lint"]],
  ["build", ["build"]],
];

export class VerificationPlanner {
  /** Converts recognized package scripts into safe, ordered verification suggestions. */
  candidates(
    profile: Pick<RepositoryProfile, "packageManager" | "scripts">,
  ): VerificationCandidate[] {
    const runner = profile.packageManager === "unknown" ? "npm run" : profile.packageManager;
    const candidate: VerificationCandidate[] = [];
    for (const [label, names] of labels) {
      const script = names.find((name) => profile.scripts[name]);
      if (script)
        candidate.push({
          label,
          command: runner === "npm run" ? `npm run ${script}` : `${runner} ${script}`,
        });
    }
    return candidate;
  }
}
