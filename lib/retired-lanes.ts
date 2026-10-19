/**
 * Retired TEST lanes (approved by Mosab 10/18/2026 after the 2-year lane scorecard,
 * study/lane-history-scorecard-2026-10-18.md: 95% range below zero and both years negative).
 *
 * A retired lane no longer computes, logs, tracks, or makes Unusual Whales calls. Its endpoints answer
 * `{ retired: true }` (plus any stored book, read-only). Stored books and study files are kept as history.
 * To bring a lane back, remove its id here (and restore its crons in vercel.json for early-ping).
 */
export const RETIRED_ON = "2026-10-18";

export const RETIRED_LANES = ["puts-breakdown", "puts-earnings-rundown", "puts", "early-ping"] as const;

export type RetiredLaneId = (typeof RETIRED_LANES)[number];

export const RETIRED_REASON = `Retired ${RETIRED_ON} after the 2-year lane scorecard (avg return range below zero in both years). No longer logged, tracked, or using Unusual Whales calls; stored history is kept.`;

export function isRetiredLane(id: string | null | undefined): boolean {
  return id != null && (RETIRED_LANES as readonly string[]).includes(id);
}

/** Response body for a retired lane's endpoint. */
export function retiredBody<T extends Record<string, unknown>>(lane: RetiredLaneId, extra?: T) {
  return { mode: "test" as const, retired: true as const, lane, retiredOn: RETIRED_ON, warning: RETIRED_REASON, ...extra };
}
