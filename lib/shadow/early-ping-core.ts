/**
 * TEST MODE ONLY — "Early ping" shadow lane core (pure helpers, client-safe).
 * Candidates: prior-afternoon (≥13:00 ET prior session) + first 15 min (9:30–9:45 ET) ask-side flow; virtual ping ~9:35 ET (8:35 CT).
 * Each candidate gets a max price = print +5% and +10%; a variant "fills" only if the contract trades at/below its max in the
 * first 60 min (9:30–10:30 ET). Exits are the live rules: +30% / −25% / 2-session hold.
 */
import { MIN_ASK_SHARE, SPREAD_MAX, spreadPct } from "@/lib/shadow/option-score-core";

export const PING_ET_MIN = 9 * 60 + 35;
export const EARLY_UNTIL_ET_MIN = 9 * 60 + 45;
export const FILL_UNTIL_ET_MIN = 10 * 60 + 30;
export const PRIOR_AFTER_ET_MIN = 13 * 60;
export const MAX_PER_DAY = 5;
export const MIN_PREMIUM = 200_000;
export const CAPS = { p5: 0.05, p10: 0.1 } as const;
export type CapId = keyof typeof CAPS;

export type EpPrint = {
  contract: string; ticker: string; issueType: string | null; side: string; printUtc: string; price: number;
  bid: number | null; ask: number | null; askShare: number; premium: number; expiry: string; day: string; etMin: number;
};

/** Same screen as the 2-year backtest (scripts/study/early-ping-backtest.py). */
export function eligible(p: EpPrint): boolean {
  const dte = (Date.parse(p.expiry) - Date.parse(p.day)) / 86_400_000;
  if (!(p.price >= 0.2) || p.premium < MIN_PREMIUM || p.askShare < Math.max(MIN_ASK_SHARE, 0.7)) return false;
  if (!(dte >= 5 && dte <= 60)) return false;
  const sp = spreadPct(p.bid, p.ask);
  if (sp != null && sp > SPREAD_MAX) return false;
  if (p.side === "put" && !["ETF", "Index"].includes(p.issueType ?? "")) return false; // ETF/index-only puts
  return true;
}

export function rankCandidates(prints: EpPrint[], max = MAX_PER_DAY): EpPrint[] {
  const best = new Map<string, EpPrint>();
  for (const p of prints) if (eligible(p) && (!best.has(p.contract) || p.premium > best.get(p.contract)!.premium)) best.set(p.contract, p);
  return [...best.values()].sort((a, b) => b.premium - a.premium).slice(0, max);
}

export const maxPrice = (print: number, cap: CapId) => Math.round(print * (1 + CAPS[cap]) * 100) / 100;
