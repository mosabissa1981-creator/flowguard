import type { FlowAlert, OptionType } from "@/lib/types";
import { toNumber } from "@/lib/numbers";

/**
 * Signed OTM fraction from the alert's own spot.
 * Call: (strike − spot) / spot. Put: (spot − strike) / spot.
 * Positive = OTM, negative = ITM, 0 = ATM. Null if strike or spot is missing.
 */
export function otmPct(
  type: OptionType,
  strike: string | number,
  spot: string | number,
): number | null {
  const k = toNumber(strike, NaN);
  const s = toNumber(spot, NaN);
  if (!(k > 0) || !(s > 0)) return null;
  return type === "call" ? (k - s) / s : (s - k) / s;
}

export function alertOtmPct(alert: Pick<FlowAlert, "type" | "strike" | "underlying_price">): number | null {
  return otmPct(alert.type, alert.strike, alert.underlying_price);
}

export type MoneynessBand = "sweet" | "near-atm" | "itm" | "deep-itm" | "far-otm" | "unknown";

/** Sep 4 hypothesis: near-ATM / modest OTM paid; deep ITM and far OTM did not. */
export function moneynessBand(pct: number | null): MoneynessBand {
  if (pct == null || !Number.isFinite(pct)) return "unknown";
  if (pct >= 0.12) return "far-otm";
  if (pct >= 0 && pct <= 0.08) return "sweet";
  if (pct >= -0.025 && pct < 0) return "near-atm";
  if (pct <= -0.1) return "deep-itm";
  if (pct < -0.025) return "itm";
  return "near-atm";
}
