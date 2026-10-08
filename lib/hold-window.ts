import { LIVE_HOLD_WINDOW } from "@/lib/exit-plan";
import type { HoldWindow, RankedFlow } from "@/lib/types";

export type { HoldWindow };

/**
 * Options hold window shown on cards — the LIVE exit rule (10/8/2026): 2 sessions, time stop 2:30 PM CT on the 2nd
 * session after entry, +30% target / −25% stop. Never a stock hold, never "hold to expiry".
 * (Retired: intraday–2 sessions / 2–7 sessions / up to ~1–2 weeks by DTE.)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildHoldWindow(_row: Pick<RankedFlow, "dte" | "askShare" | "alert" | "chips">): HoldWindow {
  return { ...LIVE_HOLD_WINDOW };
}
