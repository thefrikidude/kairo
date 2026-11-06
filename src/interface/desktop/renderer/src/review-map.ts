import type { MapNode } from "../../shared/api.js";

export type ReviewMark = "approved" | "flagged";
/** A mark only holds while the change it was made against is unchanged. */
export type StoredMark = { mark: ReviewMark; fingerprint: string };
export type NodeState = "unreviewed" | ReviewMark | "stale";

export const liveWindowMs = 15_000;

export function fingerprint(node: MapNode): string {
  return `${node.status}:${node.additions}:${node.deletions}:${Math.floor(node.mtimeMs)}`;
}

export function nodeState(node: MapNode, stored?: StoredMark): NodeState {
  if (!stored) return "unreviewed";
  return stored.fingerprint === fingerprint(node) ? stored.mark : "stale";
}

/** Credited to two or more agents: they may have overwritten each other, so look closer. */
export function isContested(node: MapNode): boolean {
  return (node.sessions?.length ?? 0) >= 2;
}

/** Files modified moments ago are the ones an agent is most likely still editing. */
export function isLive(node: MapNode, now: number): boolean {
  return node.mtimeMs > 0 && now - node.mtimeMs <= liveWindowMs;
}

/** 0..1 shade for churn, saturating around a thousand changed lines. */
export function churn(node: MapNode): number {
  return Math.min(1, Math.log10(1 + node.additions + node.deletions) / 3);
}

export const marksKey = (workspaceId: string) => `kairo:review-marks:${workspaceId}`;

export function loadMarks(workspaceId: string): Record<string, StoredMark> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(marksKey(workspaceId)) ?? "{}");
    return value && typeof value === "object" ? (value as Record<string, StoredMark>) : {};
  } catch {
    return {};
  }
}

export function saveMarks(workspaceId: string, marks: Record<string, StoredMark>): void {
  try {
    localStorage.setItem(marksKey(workspaceId), JSON.stringify(marks));
  } catch {
    // Marks are a convenience; an unavailable store only means they are not remembered.
  }
}
