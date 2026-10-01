/** Minimal Black–Scholes helpers for shadow modules (no dividends). */

export const RISK_FREE = 0.04;

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function bsPrice(S: number, K: number, T: number, sigma: number, type: "call" | "put", r = RISK_FREE): number {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  return type === "call"
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

export function impliedVol(price: number, S: number, K: number, T: number, type: "call" | "put"): number | null {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  let lo = 0.01;
  let hi = 5;
  if (bsPrice(S, K, T, hi, type) < price || bsPrice(S, K, T, lo, type) > price) return null;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, type) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Spot at which the option is worth `target` with T years left (monotone search in the profitable direction). */
export function spotForPremium(target: number, S: number, K: number, T: number, sigma: number, type: "call" | "put"): number | null {
  if (!(target > 0 && S > 0 && sigma > 0)) return null;
  let lo = type === "call" ? S * 0.5 : S * 0.2;
  let hi = type === "call" ? S * 3 : S * 1.5;
  const f = (x: number) => bsPrice(x, K, T, sigma, type) - target;
  // call value rises with spot; put value falls with spot
  if (type === "call" ? f(hi) < 0 || f(lo) > 0 : f(lo) < 0 || f(hi) > 0) return null;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if (type === "call" ? v > 0 : v < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Weekday sessions -> approximate calendar days. */
export function sessionsToCalendarDays(sessions: number): number {
  return Math.round((sessions * 7) / 5);
}
