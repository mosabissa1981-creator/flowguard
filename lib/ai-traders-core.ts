/**
 * AI trader league — pure logic (no I/O). TEST MODE paper books only.
 * Grok / Claude / GPT each get a $10k paper book on the same finalists; Friday score
 * picks a weekly winner that drives the main paper book. Not financial advice.
 */

export type AiTraderId = "grok" | "claude" | "gpt";

export const AI_TRADERS: AiTraderId[] = ["grok", "claude", "gpt"];

/** Paper book ids for the three AI traders (must stay in sync with lib/paper-core). */
export type AiTraderBookId = "ai-grok" | "ai-claude" | "ai-gpt";

export const AI_TRADER_BOOK: Record<AiTraderId, AiTraderBookId> = {
  grok: "ai-grok",
  claude: "ai-claude",
  gpt: "ai-gpt",
};

export const AI_TRADER_FROM_BOOK: Record<AiTraderBookId, AiTraderId> = {
  "ai-grok": "grok",
  "ai-claude": "claude",
  "ai-gpt": "gpt",
};

export const AI_TRADER_LABEL: Record<AiTraderId, string> = {
  grok: "Grok",
  claude: "Claude",
  gpt: "GPT",
};

/** Tighter quality bar for AI-trader paper books (live board still uses 10%). */
export const AI_TRADER_SPREAD_MAX_PCT = 0.04;
export const AI_TRADER_MIN_ASK = 2;
export const AI_TRADER_MIN_PREMIUM = 100_000;
export const AI_TRADER_MIN_SCORE = 90;
/** Fewer trades while training: hard cap per trader per day (main + premove combined). */
export const AI_TRADER_MAX_PICKS = 3;

export type QualityFacts = {
  ask: number | null;
  premiumUsd: number | null;
  score: number | null;
  spreadPct: number | null;
};

export type QualitySkip = { reason: string };

/** Pass when ask ≥ $2, premium ≥ $100k, score ≥ 90, and spread ≤ 4% (unknown spread kept). */
export function qualityGate(f: QualityFacts): { ok: true } | { ok: false; reason: string } {
  if (f.ask == null || !(f.ask >= AI_TRADER_MIN_ASK)) {
    return { ok: false, reason: `Skip: ask ${f.ask == null ? "n/a" : `$${f.ask}`} < $${AI_TRADER_MIN_ASK}.` };
  }
  if (f.premiumUsd == null || !(f.premiumUsd >= AI_TRADER_MIN_PREMIUM)) {
    return {
      ok: false,
      reason: `Skip: premium ${f.premiumUsd == null ? "n/a" : `$${Math.round(f.premiumUsd)}`} < $${AI_TRADER_MIN_PREMIUM / 1000}k.`,
    };
  }
  if (f.score == null || !(f.score >= AI_TRADER_MIN_SCORE)) {
    return { ok: false, reason: `Skip: score ${f.score ?? "n/a"} < ${AI_TRADER_MIN_SCORE}.` };
  }
  if (f.spreadPct != null && f.spreadPct > AI_TRADER_SPREAD_MAX_PCT) {
    return {
      ok: false,
      reason: `Skip: spread ${Math.round(f.spreadPct * 1000) / 10}% > ${Math.round(AI_TRADER_SPREAD_MAX_PCT * 100)}%.`,
    };
  }
  return { ok: true };
}

/** Cap a take list to AI_TRADER_MAX_PICKS (already quality-filtered). */
export function capTakes<T>(takes: T[], max: number = AI_TRADER_MAX_PICKS): T[] {
  return takes.slice(0, Math.max(0, max));
}

export type TraderWeekStanding = {
  trader: AiTraderId;
  book: AiTraderBookId;
  closed: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  avgPct: number | null;
};

export type LeagueScoreInput = {
  trader: AiTraderId;
  /** Closed trades in the week window (realized P&L). */
  closed: Array<{ pnlUsd: number; pnlPct: number }>;
};

/**
 * Rank traders for the week. Primary: total P&L; tie-break: win rate, then fewer losses, then name.
 * Needs at least one closed trade to win; otherwise winner is null.
 */
export function scoreAiTraderWeek(rows: LeagueScoreInput[]): {
  standings: TraderWeekStanding[];
  winner: AiTraderId | null;
} {
  const standings: TraderWeekStanding[] = rows.map((r) => {
    const closed = r.closed.length;
    const wins = r.closed.filter((c) => c.pnlUsd > 0).length;
    const losses = r.closed.filter((c) => c.pnlUsd <= 0).length;
    const pnlUsd = Math.round(r.closed.reduce((s, c) => s + c.pnlUsd, 0) * 100) / 100;
    const avgPct =
      closed > 0 ? Math.round((r.closed.reduce((s, c) => s + c.pnlPct, 0) / closed) * 100) / 100 : null;
    return { trader: r.trader, book: AI_TRADER_BOOK[r.trader], closed, wins, losses, pnlUsd, avgPct };
  });
  standings.sort((a, b) => {
    if (a.pnlUsd !== b.pnlUsd) return b.pnlUsd - a.pnlUsd;
    const aw = a.closed ? a.wins / a.closed : -1;
    const bw = b.closed ? b.wins / b.closed : -1;
    if (aw !== bw) return bw - aw;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return a.trader.localeCompare(b.trader);
  });
  const top = standings.find((s) => s.closed > 0) ?? null;
  return { standings, winner: top?.trader ?? null };
}

/** Monday (ET date string) of the week containing `day` (YYYY-MM-DD). */
export function weekStartMonday(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.getUTCDay(); // 0 Sun … 6 Sat
  const back = wd === 0 ? 6 : wd - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Friday of that week. */
export function weekEndFriday(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4);
  return d.toISOString().slice(0, 10);
}

/** Closed trade counts as in-week when exit day is Mon–Fri of that week (inclusive). */
export function inWeek(exitDay: string, weekStart: string, weekEnd: string): boolean {
  return exitDay >= weekStart && exitDay <= weekEnd;
}
