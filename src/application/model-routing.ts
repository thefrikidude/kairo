import type { ModelSelection } from "../domain/models.js";
import type { JevModelTier } from "../domain/ports.js";

export type AvailableModel = ModelSelection & {
  apiKey: string;
  tier: JevModelTier;
};

/** Selects only from locally credentialed models; the manual selection is the deterministic fallback. */
export function selectAutoModel(
  available: AvailableModel[],
  manual: ModelSelection,
  tier: JevModelTier,
): AvailableModel | undefined {
  const preferred = available.filter((candidate) => candidate.tier === tier);
  return (
    preferred.find(
      (candidate) => candidate.provider === manual.provider && candidate.model === manual.model,
    ) ??
    preferred[0] ??
    available.find(
      (candidate) => candidate.provider === manual.provider && candidate.model === manual.model,
    ) ??
    available[0]
  );
}

/** Orders replacement models after quota exhaustion, preferring a different provider first. */
export function quotaFallbackModels(
  available: AvailableModel[],
  selected: ModelSelection,
  manual: ModelSelection,
  tier: JevModelTier,
): AvailableModel[] {
  const remaining = available.filter(
    (candidate) => candidate.provider !== selected.provider || candidate.model !== selected.model,
  );
  const rank = (candidate: AvailableModel): number => {
    const sameProvider = candidate.provider === selected.provider;
    const sameTier = candidate.tier === tier;
    const manualModel = candidate.provider === manual.provider && candidate.model === manual.model;
    if (!sameProvider && sameTier) return 0;
    if (!sameProvider && manualModel) return 1;
    if (!sameProvider) return 2;
    if (sameTier) return 3;
    if (manualModel) return 4;
    return 5;
  };
  return remaining.sort((left, right) => rank(left) - rank(right));
}

/** Builds bounded, credential-free metadata for the TypeSafe decision request. */
export function modelRoutingState(request: string, candidates: AvailableModel[]): string {
  return [
    `Task request: ${request.replace(/(?:sk|gsk|or|AIza)[-_a-zA-Z0-9]{12,}/g, "[redacted]").slice(0, 1_500)}`,
    `Available model tiers: ${candidates
      .map((candidate) => `${candidate.provider}/${candidate.model}=${candidate.tier}`)
      .join(", ")
      .slice(0, 1_500)}`,
    "Choose the coding-model tier only. Credentials, source files, and tool output are not included.",
  ].join("\n");
}
