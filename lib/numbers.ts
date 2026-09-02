export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/,/g, "");
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  return false;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function daysToExpiry(expiry: string, now = new Date()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (!match) return 0;
  const expUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((expUtc - todayUtc) / 86_400_000));
}

export function askShare(alert: {
  total_ask_side_prem: string | number;
  total_bid_side_prem: string | number;
}): number {
  const ask = Math.max(0, toNumber(alert.total_ask_side_prem));
  const bid = Math.max(0, toNumber(alert.total_bid_side_prem));
  const denom = ask + bid;
  if (denom <= 0) return 0.5;
  return ask / denom;
}

export function tideFromPremiums(
  netCallPremium: number,
  netPutPremium: number,
  timestamp: string | null,
): {
  timestamp: string | null;
  netCallPremium: number;
  netPutPremium: number;
  netPremium: number;
  bias: "bullish" | "bearish" | "neutral";
} {
  const netPremium = netCallPremium - netPutPremium;
  const magnitude = Math.max(Math.abs(netCallPremium), Math.abs(netPutPremium), 1);
  const ratio = netPremium / magnitude;
  let bias: "bullish" | "bearish" | "neutral" = "neutral";
  if (ratio >= 0.18) bias = "bullish";
  else if (ratio <= -0.18) bias = "bearish";
  return { timestamp, netCallPremium, netPutPremium, netPremium, bias };
}
