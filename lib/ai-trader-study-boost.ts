/**
 * PAPER / TEST ONLY. Study boost for the competing AI-trader books.
 * Default ON through AI_TRADER_STUDY_BOOST_END. Set FLOWGUARD_AI_TRADER_STUDY_BOOST=0 to turn it off,
 * or set it to YYYY-MM-DD to keep it on through that day. No I/O.
 *
 * While it is on, Grok / Claude / GPT review a wider pool in more batches, and each AI book may
 * paper-fill more takes. The $3 quiet-test ledger is still the hard stop. Live picks are untouched.
 */

export const AI_TRADER_STUDY_BOOST_END = "2026-12-11";
/** Report-day / risky list cap rises to this. Calm stays at 10 (already higher). Study tier uses the same count. */
export const AI_TRADER_BOOST_FILL_CAP = 8;
/** Live spread gate. Rows inside this and outside the 4% quality floor are the study tier. */
export const AI_TRADER_LIVE_SPREAD_MAX = 0.1;
/** Wide-pool live floor (near-miss). Quality still requires score ≥ 90 and premium ≥ $100k. */
export const AI_TRADER_LIVE_MIN_SCORE = 45;
export const AI_TRADER_LIVE_MIN_PREMIUM = 10_000;
/**
 * Open-cost room on the four AI books while the boost is on, so a list of 8 can actually fill
 * (8 × the 5% one-contract max). Main stays at 10%.
 */
export const AI_TRADER_BOOST_OPEN_RISK = 0.4;

export type ReviewPace = {
  perRun: number;
  intervalMs: number;
  fromEt: number;
  toEt: number;
  dailyMaxDefault: number;
  dailyMaxHard: number;
  usdDefault: number;
  usdHard: number;
};

const MIN = 60_000;

export function studyBoostUntil(raw: string | undefined | null): string {
  const v = (raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : AI_TRADER_STUDY_BOOST_END;
}

/** Default ON (unset, "1", "on") through the end date. "0" / "off" disables. A YYYY-MM-DD value replaces the end date. */
export function studyBoostEnabled(raw: string | undefined | null, today: string): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  if (v !== "" && v !== "1" && v !== "on" && v !== "true" && v !== "yes" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const end = studyBoostUntil(v === "" || v === "1" || v === "on" || v === "true" || v === "yes" ? null : v);
  return today <= end;
}

export function grokWidePace(boost: boolean): ReviewPace {
  return boost
    ? { perRun: 80, intervalMs: 20 * MIN, fromEt: 10 * 60, toEt: 15 * 60, dailyMaxDefault: 600, dailyMaxHard: 1000, usdDefault: 1, usdHard: 3 }
    : { perRun: 100, intervalMs: 45 * MIN, fromEt: 10 * 60, toEt: 14 * 60 + 30, dailyMaxDefault: 200, dailyMaxHard: 1000, usdDefault: 1, usdHard: 3 };
}

export function claudeSecondPace(boost: boolean): ReviewPace {
  return boost
    ? { perRun: 80, intervalMs: 20 * MIN, fromEt: 10 * 60, toEt: 15 * 60, dailyMaxDefault: 600, dailyMaxHard: 800, usdDefault: 1.25, usdHard: 1.5 }
    : { perRun: 60, intervalMs: 40 * MIN, fromEt: 10 * 60, toEt: 15 * 60, dailyMaxDefault: 300, dailyMaxHard: 500, usdDefault: 0.75, usdHard: 1 };
}

export function gptThirdPace(boost: boolean): ReviewPace {
  return boost
    ? { perRun: 80, intervalMs: 20 * MIN, fromEt: 10 * 60, toEt: 15 * 60, dailyMaxDefault: 600, dailyMaxHard: 800, usdDefault: 0.6, usdHard: 0.75 }
    : { perRun: 60, intervalMs: 40 * MIN, fromEt: 10 * 60, toEt: 15 * 60, dailyMaxDefault: 300, dailyMaxHard: 500, usdDefault: 0.6, usdHard: 0.75 };
}

/** Higher score first, then earlier print, so a budget stop keeps the rows we most want judged. */
export function byScoreThenEarlier(a: { score: number; at: string; contract: string }, b: { score: number; at: string; contract: string }): number {
  return b.score - a.score || a.at.localeCompare(b.at) || a.contract.localeCompare(b.contract);
}

/**
 * Expected quiet-test AI spend for one session.
 * Batch prices: Grok $0.0208 is the Oct 2026 wide backtest (318 batches, $6.622). Claude ~2× that
 * (sonnet output is $15/M vs grok-4.7 $6/M). GPT-4.1-mini ~$0.005. GEX/DEX is unchanged code; it
 * only sees more rows because Grok judged more, and it still stops at its own cap. Shadow is the
 * other quiet lane at a typical day, not its $1 ceiling.
 * The walk stops a lane when the next batch would cross that lane's cap or the $3 total.
 */
export type SpendProjection = {
  boost: boolean;
  totalUsd: number;
  hardCapUsd: 3;
  lanes: Record<string, { rows: number; usd: number }>;
  /** Judged rows above the boost-off projection. */
  extraRows: { grok: number; claude: number; gpt: number };
  /** Quality list cap while boosted (calm stays 10). Study tier adds this many more per AI book. */
  qualityListCapReportDay: number;
  studyFillsPerAiBook: number;
};

const BATCH = 20;
const BATCH_USD = { grok: 0.0208, claude: 0.042, gpt: 0.005, gex: 0.03 } as const;
const SHADOW_TYPICAL_USD = 0.4;

function projectDay(boost: boolean): Record<string, { rows: number; usd: number }> {
  const g = grokWidePace(boost);
  const c = claudeSecondPace(boost);
  const p = gptThirdPace(boost);
  const lanes = {
    shadow: { rows: 0, usd: SHADOW_TYPICAL_USD, rowCap: 0, usdCap: 1, perRun: 0, batchUsd: 0 },
    grok: { rows: 0, usd: 0, rowCap: g.dailyMaxDefault, usdCap: g.usdDefault, perRun: g.perRun, batchUsd: BATCH_USD.grok },
    gex: { rows: 0, usd: 0, rowCap: 300, usdCap: 0.75, perRun: 60, batchUsd: BATCH_USD.gex },
    claude: { rows: 0, usd: 0, rowCap: c.dailyMaxDefault, usdCap: c.usdDefault, perRun: c.perRun, batchUsd: BATCH_USD.claude },
    gpt: { rows: 0, usd: 0, rowCap: p.dailyMaxDefault, usdCap: p.usdDefault, perRun: p.perRun, batchUsd: BATCH_USD.gpt },
  };
  let quiet = SHADOW_TYPICAL_USD;
  const order = ["grok", "gex", "claude", "gpt"] as const;
  for (let guard = 0; guard < 80; guard++) {
    let progress = false;
    for (const id of order) {
      const lane = lanes[id];
      const available = id === "grok" ? lane.rowCap : Math.min(lane.rowCap, lanes.grok.rows);
      let room = Math.min(lane.perRun, available - lane.rows);
      while (room > 0) {
        const n = Math.min(BATCH, room);
        const cost = Math.round(lane.batchUsd * (n / BATCH) * 10000) / 10000;
        if (lane.usd + cost > lane.usdCap + 1e-9) {
          room = 0;
          break;
        }
        if (quiet + cost > 3 + 1e-9) {
          room = 0;
          break;
        }
        lane.rows += n;
        lane.usd = Math.round((lane.usd + cost) * 10000) / 10000;
        quiet = Math.round((quiet + cost) * 10000) / 10000;
        room -= n;
        progress = true;
      }
    }
    if (!progress) break;
  }
  return {
    shadow: { rows: 0, usd: lanes.shadow.usd },
    grok: { rows: lanes.grok.rows, usd: lanes.grok.usd },
    gex: { rows: lanes.gex.rows, usd: lanes.gex.usd },
    claude: { rows: lanes.claude.rows, usd: lanes.claude.usd },
    gpt: { rows: lanes.gpt.rows, usd: lanes.gpt.usd },
  };
}

export function projectQuietSpend(boost: boolean): SpendProjection {
  const on = projectDay(true);
  const off = projectDay(false);
  const lanes = boost ? on : off;
  const total = Object.values(lanes).reduce((s, l) => s + l.usd, 0);
  return {
    boost,
    totalUsd: Math.round(total * 100) / 100,
    hardCapUsd: 3,
    lanes,
    extraRows: boost
      ? {
          grok: on.grok.rows - off.grok.rows,
          claude: on.claude.rows - off.claude.rows,
          gpt: on.gpt.rows - off.gpt.rows,
        }
      : { grok: 0, claude: 0, gpt: 0 },
    qualityListCapReportDay: boost ? AI_TRADER_BOOST_FILL_CAP : 3,
    studyFillsPerAiBook: boost ? AI_TRADER_BOOST_FILL_CAP : 0,
  };
}
