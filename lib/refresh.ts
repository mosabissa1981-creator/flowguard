/**
 * Board and cache intervals. Change BOARD_REFRESH_MS to 30 or 60 minutes later.
 * Client auto-poll and server tape TTL stay aligned from these constants.
 */
export const BOARD_REFRESH_MS = 15 * 60_000;

/** Price-alert quote checks — own path, same default cadence as the board. */
export const WATCH_CHECK_MS = 15 * 60_000;

/**
 * Shared UW session-tape cache. Slightly under the board poll so a 15-minute
 * refresh usually does one UW pull; anything faster (SSR, extra tabs) hits cache.
 */
export const TAPE_CACHE_MS = 12 * 60_000;

export const TAPE_CACHE_SEC = Math.round(TAPE_CACHE_MS / 1000);

export function wantFresh(searchParams: URLSearchParams): boolean {
  const value = searchParams.get("fresh");
  return value === "1" || value === "true";
}

export function tapeCacheControl(forceFresh: boolean): HeadersInit {
  if (forceFresh) return { "Cache-Control": "no-store" };
  return {
    "Cache-Control": `s-maxage=${TAPE_CACHE_SEC}, stale-while-revalidate=60`,
  };
}

export function formatRefreshCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.round(secondsLeft));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${s}s`;
  if (r === 0) return `${m}m`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}
