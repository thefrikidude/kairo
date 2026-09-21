import type {
  FailureEvidence,
  RepositorySnapshot,
  VerificationCandidate,
  VerificationSelection,
} from "../domain/models.js";

const labels: Array<[VerificationCandidate["label"], string[]]> = [
  ["test", ["test", "test:unit", "test:run"]],
  ["typecheck", ["typecheck", "type-check", "check"]],
  ["lint", ["lint"]],
  ["build", ["build"]],
];

export class VerificationPlanner {
  /** Converts recognized package scripts into safe, ordered verification suggestions. */
  candidates(
    profile: Pick<RepositorySnapshot, "packageManager" | "scripts"> &
      Partial<Pick<RepositorySnapshot, "manifestFiles">>,
  ): VerificationCandidate[] {
    const runner = profile.packageManager === "unknown" ? "npm run" : profile.packageManager;
    const candidate: VerificationCandidate[] = [];
    for (const [label, names] of labels) {
      const script = names.find((name) => profile.scripts[name]);
      if (script)
        candidate.push({
          label,
          command: runner === "npm run" ? `npm run ${script}` : `${runner} ${script}`,
          scope: "broad",
          reason: `Discovered ${script} package script.`,
          evidence: [
            {
              path:
                profile.manifestFiles?.find((path) => path.endsWith("package.json")) ??
                "package.json",
              kind: "manifest",
            },
            ...(profile.packageManager === "unknown"
              ? []
              : [{ path: this.lockfile(profile.packageManager), kind: "lockfile" as const }]),
          ],
        });
    }
    return candidate;
  }

  private lockfile(
    packageManager: Exclude<RepositorySnapshot["packageManager"], "unknown">,
  ): string {
    return {
      npm: "package-lock.json",
      pnpm: "pnpm-lock.yaml",
      yarn: "yarn.lock",
      bun: "bun.lock",
    }[packageManager];
  }

  /** Selects the narrowest known check that plausibly covers changed or failing files. */
  select(
    profile: Pick<
      RepositorySnapshot,
      "sourceRoots" | "testRoots" | "configFiles" | "verificationCandidates"
    >,
    changedFiles: string[],
    failure?: FailureEvidence,
  ): VerificationSelection | undefined {
    const candidates = profile.verificationCandidates;
    if (!candidates.length) return undefined;
    const changed = [
      ...new Set([
        ...changedFiles,
        ...(failure ? failure.fileLocations.map((item) => item.path) : []),
      ]),
    ];
    const byLabel = (label: VerificationCandidate["label"]) =>
      candidates.find((candidate) => candidate.label === label);
    const selection = (
      candidate: VerificationCandidate | undefined,
      scope: VerificationSelection["scope"],
      reason: string,
    ): VerificationSelection | undefined =>
      candidate && {
        command: candidate.command,
        label: candidate.label,
        scope,
        reason,
        source: "recommended",
      };
    const isTest = changed.some(
      (path) =>
        profile.testRoots.some((root) => path === root || path.startsWith(`${root}/`)) ||
        /(?:^|[./_-])(test|spec)(?:[._-]|$)/i.test(path),
    );
    if (isTest)
      return selection(
        byLabel("test"),
        "broad",
        "Changed or failing test file is covered by the test script.",
      );
    const isSource = changed.some((path) =>
      profile.sourceRoots.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    if (isSource && byLabel("typecheck"))
      return selection(
        byLabel("typecheck"),
        "broad",
        "Changed source file is covered by typechecking.",
      );
    const isConfig = changed.some(
      (path) =>
        profile.configFiles.includes(path) || /(?:^|\/)(?:package|tsconfig)\.json$/.test(path),
    );
    if (isConfig)
      return selection(
        byLabel("test") ?? byLabel("typecheck"),
        "broad",
        "Configuration change needs a project-level check.",
      );
    return selection(
      byLabel("test") ?? byLabel("typecheck") ?? candidates[0],
      "broad",
      "No narrower coverage could be established.",
    );
  }

  /** Labels a command chosen outside the recommender without rejecting manual or model fallback. */
  selectionForCommand(
    profile: Pick<RepositorySnapshot, "verificationCandidates"> | undefined,
    command: string,
    source: Exclude<VerificationSelection["source"], "recommended">,
  ): VerificationSelection {
    const candidate = profile?.verificationCandidates.find((item) => item.command === command);
    return {
      command,
      label: candidate?.label ?? "custom",
      scope: candidate?.scope ?? "broad",
      reason: candidate?.reason ?? "Command selected outside automatic recommendation.",
      source,
    };
  }

  /** Returns a broader project check only after a focused recommendation has passed. */
  broader(
    profile: Pick<RepositorySnapshot, "verificationCandidates">,
    completed: VerificationSelection,
  ): VerificationSelection | undefined {
    const candidate = profile.verificationCandidates.find(
      (item) => item.label === "test" && item.command !== completed.command,
    );
    if (!candidate) return undefined;
    return {
      command: candidate.command,
      label: candidate.label,
      scope: "broad",
      reason: "Typechecking passed; run the project tests for behavioral coverage.",
      source: "recommended",
    };
  }
}
