import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

/** The zoom the app was last quit at, or 100% when nothing usable was saved. */
export function readSavedZoom(file: string): number {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8")).zoom;
    if (typeof saved === "number" && saved >= ZOOM_MIN && saved <= ZOOM_MAX)
      return Math.round(saved * 10) / 10;
  } catch {
    /* no saved zoom yet, or an unreadable file */
  }
  return 1;
}

export function writeSavedZoom(file: string, zoom: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ zoom }));
  } catch {
    /* the zoom still applies for this run */
  }
}
