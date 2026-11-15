import "server-only";

import {
  AI_TRADER_BOOK,
  AI_TRADER_FROM_BOOK,
  AI_TRADER_LABEL,
  AI_TRADER_MAX_PICKS,
  AI_TRADER_SPREAD_MAX_PCT,
  AI_TRADERS,
  capTakes,
  inWeek,
  qualityGate,
  scoreAiTraderWeek,
  weekEndFriday,
  weekStartMonday,
  type AiTraderBookId,
  type AiTraderId,
  type TraderWeekStanding,
} from "@/lib/ai-traders-core";
import { ledgerAdd, ledgerSpend, llmPersistenceGate, testModeGrokBatchFits, testModeGrokSpend } from "@/lib/llm-ledger";
import { kvGet, kvSet } from "@/lib/kv";
import { toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";
import { anthropicLlmConfig, callShadowLlm, openaiLlmConfig, type ShadowLlmConfig } from "@/lib/shadow/llm";
import { gatherCandidates } from "@/lib/ai-picks";
import { buildExitPlan, LIVE_HOLD_WINDOW, withLiveExitRule } from "@/lib/exit-plan";
import { loadRegimeSafe } from "@/lib/regime";
import { contractKey } from "@/lib/scoring";
import type { AiPick, AiPicksResponse, DailyPick } from "@/lib/types";
import type { PaperClosed } from "@/lib/paper-core";

/**
 * AI trader league (TEST MODE). Same finalists → Grok / Claude / GPT each take/skip into their own
 * paper books. Friday score sets next week's main-book driver. Never places orders.
 *
 * Grok takes: mirrored from /api/ai-picks (no second Grok bill).
 * Claude / GPT: optional peer calls on the same finalists when keys are set.
 */

const K_TAKES = (t: AiTraderId) => `paper:ai-trader-takes:${t}`;
const K_LEAGUE = "paper:ai-trader-league";
const PEER_MIN_INTERVAL_MS = 30 * 60_000;
const PEER_USD_CAP = 0.5;

export type AiTraderTake = {
  source: "ai-pick" | "premove";
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  alertPrice: number;
  confidence: number | null;
  reason?: string;
  alertBid?: number | null;
  alertAsk?: number | null;
  issueType?: string | null;
  score?: number | null;
  premiumUsd?: number | null;
  plan: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; timeStopDate: string } | null;
};

export type AiTraderTakesDoc = {
  day: string;
  at: string;
  trader: AiTraderId;
  provider: string;
  model: string | null;
  engine: "llm" | "deterministic" | "mirrored";
  picks: AiTraderTake[];
  skippedQuality: number;
  note: string;
};

export type AiTraderLeagueDoc = {
  version: 1;
  mode: "test";
  /** Monday of the week just scored. */
  weekStart: string;
  weekEnd: string;
  scoredAt: string;
  standings: TraderWeekStanding[];
  /** Winner of that week — drives main paper until the next Friday score. */
  winner: AiTraderId | null;
  /** Trader whose takes fill the main book right now (null = primary /api/ai-picks). */
  activeTrader: AiTraderId | null;
  note: string;
};

function num(v: unknown): number | null {
  const n = toNumber(v);
  return Number.isFinite(n) ? n : null;
}

function takeFromPick(p: AiPick, source: AiTraderTake["source"]): { take: AiTraderTake | null; qualitySkip: string | null } {
  const a = p.alert;
  const ask = num(a.ask) ?? num(a.price);
  const premiumUsd = num(a.total_premium);
  const score = Number.isFinite(p.score) ? p.score : null;
  const spreadPct = p.spread?.pct ?? null;
  const gate = qualityGate({ ask, premiumUsd, score, spreadPct });
  if (!gate.ok) return { take: null, qualitySkip: gate.reason };
  const plan = p.exitPlan;
  return {
    qualitySkip: null,
    take: {
      source,
      contract: a.option_chain || a.id,
      ticker: a.ticker,
      side: a.type,
      strike: toNumber(a.strike),
      expiry: a.expiry.slice(0, 10),
      alertPrice: toNumber(a.price) || toNumber(a.ask),
      confidence: Number.isFinite(p.confidence) ? p.confidence : null,
      reason: p.aiReason,
      alertBid: a.bid ? toNumber(a.bid) : null,
      alertAsk: a.ask ? toNumber(a.ask) : null,
      issueType: a.issue_type || null,
      score,
      premiumUsd,
      plan: plan
        ? {
            entry: plan.entry,
            target: plan.target,
            targetPct: plan.targetPct,
            stop: plan.stop,
            stopPct: plan.stopPct,
            timeStopDate: plan.timeStop.date,
          }
        : null,
    },
  };
}

function filterTakes(picks: AiPick[], source: AiTraderTake["source"]): { takes: AiTraderTake[]; skippedQuality: number } {
  const takes: AiTraderTake[] = [];
  let skippedQuality = 0;
  for (const p of picks) {
    const { take, qualitySkip } = takeFromPick(p, source);
    if (qualitySkip) {
      skippedQuality += 1;
      continue;
    }
    if (take) takes.push(take);
  }
  return { takes: capTakes(takes), skippedQuality };
}

async function saveTakes(doc: AiTraderTakesDoc): Promise<void> {
  await kvSet(K_TAKES(doc.trader), doc, { tier: "hot", ttlSec: 14 * 86400 });
}

export async function loadAiTraderTakes(trader: AiTraderId, day?: string): Promise<AiTraderTakesDoc | null> {
  const doc = await kvGet<AiTraderTakesDoc>(K_TAKES(trader), { maxAgeMs: 30_000 });
  if (!doc) return null;
  if (day && doc.day !== day) return null;
  return doc;
}

export async function loadAiTraderLeague(): Promise<AiTraderLeagueDoc | null> {
  return kvGet<AiTraderLeagueDoc>(K_LEAGUE, { maxAgeMs: 60_000 });
}

/** Mirror Grok's /api/ai-picks takes into the ai-grok paper book (quality-filtered). */
export async function noteGrokTraderTakes(payload: AiPicksResponse): Promise<AiTraderTakesDoc | null> {
  if (!payload || payload.source === "mock") return null;
  const today = tradingDateET(new Date(payload.generatedAt));
  const a = filterTakes(payload.picks ?? [], "ai-pick");
  const b = filterTakes(payload.premove?.picks ?? [], "premove");
  const doc: AiTraderTakesDoc = {
    day: today,
    at: payload.generatedAt,
    trader: "grok",
    provider: payload.llmProvider ?? "primary",
    model: payload.llmModel ?? null,
    engine: payload.engine === "llm" ? "mirrored" : "deterministic",
    picks: capTakes([...a.takes, ...b.takes]),
    skippedQuality: a.skippedQuality + b.skippedQuality,
    note: "TEST MODE AI trader · Grok — mirrored from /api/ai-picks after quality gate (spread ≤4%, ask ≥$2, prem ≥$100k, score ≥90, max 3).",
  };
  await saveTakes(doc);
  return doc;
}

type Finalist = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  score: number;
  lanes: string[];
  optionPrint: number;
  premiumUsd: number;
  ask: number | null;
  bid: number | null;
  spreadPct: number | null;
  issueType: string | null;
  sourceLane: "ai-pick" | "premove";
  row: DailyPick & { lanes: string[] };
};

function toFinalist(row: DailyPick & { lanes: string[] }, sourceLane: "ai-pick" | "premove"): Finalist {
  const a = row.alert;
  return {
    contract: contractKey(row),
    ticker: a.ticker,
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry.slice(0, 10),
    dte: row.dte,
    score: row.score,
    lanes: row.lanes ?? [],
    optionPrint: toNumber(a.price),
    premiumUsd: toNumber(a.total_premium),
    ask: num(a.ask),
    bid: num(a.bid),
    spreadPct: row.spread?.pct ?? null,
    issueType: a.issue_type || null,
    sourceLane,
    row,
  };
}

function asAiPick(row: DailyPick & { lanes: string[] }, confidence: number, reason: string, risky: boolean): AiPick {
  const day = tradingDateET();
  const built = buildExitPlan(row, { riskyRegime: risky, confidence });
  const exitPlan = withLiveExitRule(built, day, row.alert.expiry) ?? built;
  return { ...row, confidence, aiReason: reason, exitPlan, holdWindow: { ...LIVE_HOLD_WINDOW } };
}

function peerSystem(maxPicks: number): string {
  return [
    "You are one AI trader in a FlowGuard paper-trading league (TEST MODE). You do NOT predict prices.",
    `Choose 0–${maxPicks} contracts ONLY from the candidate list (exact contract id).`,
    "Prefer morning ask-side, quiet underlying, 11–30 DTE. Distrust late prints and same-issuer clusters.",
    "Every candidate you do not pick must appear in skips with a short reason.",
    'Respond with JSON only: {"picks":[{"contract":"...","confidence":0-100,"reason":"<=200 chars"}],"skips":[{"contract":"...","reason":"<=160 chars"}]}',
  ].join(" ");
}

function parsePeer(text: string): { picks: { contract: string; confidence: number; reason: string }[]; skips: { contract: string; reason: string }[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as {
      picks?: { contract?: string; confidence?: number; reason?: string }[];
      skips?: { contract?: string; reason?: string }[];
    };
    if (!Array.isArray(raw.picks)) return null;
    return {
      picks: raw.picks
        .filter((p) => p && typeof p.contract === "string")
        .map((p) => ({
          contract: String(p.contract).trim(),
          confidence: Math.max(0, Math.min(100, Number(p.confidence) || 0)),
          reason: String(p.reason ?? "").slice(0, 280),
        })),
      skips: (Array.isArray(raw.skips) ? raw.skips : [])
        .filter((s) => s && typeof s.contract === "string")
        .map((s) => ({ contract: String(s.contract).trim(), reason: String(s.reason ?? "").slice(0, 240) })),
    };
  } catch {
    return null;
  }
}

async function runPeer(
  trader: "claude" | "gpt",
  payload: AiPicksResponse,
  finalists: Finalist[],
  risky: boolean,
  cfg: ShadowLlmConfig,
  ledger: "ai-trader-claude" | "ai-trader-gpt",
): Promise<AiTraderTakesDoc | null> {
  const today = tradingDateET(new Date(payload.generatedAt));
  const eligible = finalists.filter((f) =>
    qualityGate({ ask: f.ask ?? f.optionPrint, premiumUsd: f.premiumUsd, score: f.score, spreadPct: f.spreadPct }).ok,
  );
  if (eligible.length === 0) {
    const empty: AiTraderTakesDoc = {
      day: today,
      at: new Date().toISOString(),
      trader,
      provider: cfg.provider,
      model: cfg.model,
      engine: "llm",
      picks: [],
      skippedQuality: finalists.length,
      note: `TEST MODE AI trader · ${AI_TRADER_LABEL[trader]} — no quality-passing finalists today.`,
    };
    await saveTakes(empty);
    return empty;
  }

  const prev = await loadAiTraderTakes(trader);
  if (prev?.day === today && prev.at) {
    const age = Date.now() - Date.parse(prev.at);
    if (Number.isFinite(age) && age < PEER_MIN_INTERVAL_MS) return prev;
  }

  const day = today;
  const gate = llmPersistenceGate(ledger, day);
  if (!gate.ok) return null;
  const spent = await ledgerSpend(ledger, day).catch(() => 0);
  if (spent >= PEER_USD_CAP) return prev?.day === today ? prev : null;
  const quiet = await testModeGrokSpend(day).catch(() => 0);
  if (!testModeGrokBatchFits(quiet, 0.15)) return prev?.day === today ? prev : null;

  const user = JSON.stringify({
    maxPicks: AI_TRADER_MAX_PICKS,
    regime: payload.regime,
    candidates: eligible.map((f) => ({
      contract: f.contract,
      ticker: f.ticker,
      side: f.side,
      strike: f.strike,
      expiry: f.expiry,
      dte: f.dte,
      score: f.score,
      lanes: f.lanes,
      optionPrint: f.optionPrint,
      premiumUsd: f.premiumUsd,
      ask: f.ask,
      spreadPct: f.spreadPct,
      sourceLane: f.sourceLane,
    })),
  });

  try {
    const res = await callShadowLlm(
      { module: `ai-trader-${trader}`, system: peerSystem(AI_TRADER_MAX_PICKS), user, cfg, model: cfg.model },
      ledger,
    );
    await ledgerAdd(ledger, day, 0).catch(() => 0);

    const decision = parsePeer(res.text);
    const byContract = new Map(eligible.map((f) => [f.contract, f] as const));
    const takes: AiTraderTake[] = [];
    let skippedQuality = finalists.length - eligible.length;
    for (const p of decision?.picks ?? []) {
      const f = byContract.get(p.contract);
      if (!f) continue;
      const { take, qualitySkip } = takeFromPick(asAiPick(f.row, p.confidence, p.reason, risky), f.sourceLane);
      if (qualitySkip) {
        skippedQuality += 1;
        continue;
      }
      if (take) takes.push({ ...take, reason: p.reason, confidence: p.confidence });
    }
    const doc: AiTraderTakesDoc = {
      day: today,
      at: new Date().toISOString(),
      trader,
      provider: cfg.provider,
      model: cfg.model,
      engine: "llm",
      picks: capTakes(takes),
      skippedQuality,
      note: `TEST MODE AI trader · ${AI_TRADER_LABEL[trader]} — peer review of the same AI-picks finalists (quality gate + max ${AI_TRADER_MAX_PICKS}).`,
    };
    await saveTakes(doc);
    return doc;
  } catch (e) {
    console.warn(`[ai-traders] ${trader} peer failed: ${e instanceof Error ? e.message : String(e)}`);
    return prev?.day === today ? prev : null;
  }
}

/**
 * After /api/ai-picks: mirror Grok takes, then optionally ask Claude + GPT on the same finalists.
 * Never throws. Never changes the live ai-picks payload.
 */
export async function runAiTraderLeagueQuietly(payload: AiPicksResponse | null | undefined): Promise<void> {
  if (!payload || payload.source === "mock") return;
  try {
    await noteGrokTraderTakes(payload);
  } catch (e) {
    console.warn(`[ai-traders] grok mirror failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Same finalist pool Grok's AI-picks desk used (re-gathered), quality-filtered for peers.
  let finalists: Finalist[] = [];
  let risky = Boolean(payload.regime?.rules?.active);
  try {
    const gathered = await gatherCandidates();
    const regime = await loadRegimeSafe().catch(() => null);
    risky = Boolean(regime?.rules.active);
    finalists = [
      ...(gathered.cands ?? []).map((r) => toFinalist(r, r.lanes.includes("premove") && !r.lanes.includes("morning") && !r.lanes.includes("picks") ? "premove" : "ai-pick")),
      ...(gathered.premoveCands ?? [])
        .filter((r) => !(gathered.cands ?? []).some((c) => contractKey(c) === contractKey(r)))
        .map((r) => toFinalist(r, "premove")),
    ];
  } catch (e) {
    console.warn(`[ai-traders] gather failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (finalists.length === 0) return;
  try {
    const claude = anthropicLlmConfig();
    if (claude && process.env.FLOWGUARD_AI_TRADER_CLAUDE?.trim() !== "0") {
      await runPeer("claude", payload, finalists, risky, claude, "ai-trader-claude");
    }
  } catch (e) {
    console.warn(`[ai-traders] claude: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const gpt = openaiLlmConfig();
    if (gpt && process.env.FLOWGUARD_AI_TRADER_GPT?.trim() !== "0") {
      await runPeer("gpt", payload, finalists, risky, gpt, "ai-trader-gpt");
    }
  } catch (e) {
    console.warn(`[ai-traders] gpt: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Friday (or force): score the three AI trader paper books for the week and set next week's activeTrader.
 * `closed` should be the full closed list from paper state.
 */
export function buildLeagueScore(
  closed: PaperClosed[],
  now: Date,
  opts: { forceWeekStart?: string } = {},
): AiTraderLeagueDoc {
  const today = tradingDateET(now);
  const weekStart = opts.forceWeekStart ?? weekStartMonday(today);
  const weekEnd = weekEndFriday(weekStart);
  const rows = AI_TRADERS.map((trader) => {
    const book = AI_TRADER_BOOK[trader];
    const weekClosed = closed.filter((c) => c.book === book && inWeek(tradingDateET(new Date(c.exitedAt)), weekStart, weekEnd));
    return { trader, closed: weekClosed.map((c) => ({ pnlUsd: c.pnlUsd, pnlPct: c.pnlPct })) };
  });
  const { standings, winner } = scoreAiTraderWeek(rows);
  return {
    version: 1,
    mode: "test",
    weekStart,
    weekEnd,
    scoredAt: now.toISOString(),
    standings,
    winner,
    activeTrader: winner,
    note: winner
      ? `TEST MODE: ${AI_TRADER_LABEL[winner]} won week ${weekStart} → drives main paper until next Friday score.`
      : `TEST MODE: no closed AI-trader trades in week ${weekStart}; main stays on primary /api/ai-picks.`,
  };
}

/** Persist a league score if Friday ET (after 15:30) or force. Returns the doc when written/loaded. */
export async function maybeScoreAiTraderWeek(
  closed: PaperClosed[],
  now: Date,
  opts: { force?: boolean; etDay?: string; etMinutes?: number } = {},
): Promise<AiTraderLeagueDoc | null> {
  const etDay = opts.etDay ?? tradingDateET(now);
  const etMinutes = opts.etMinutes;
  const wd = new Date(`${etDay}T12:00:00Z`).getUTCDay(); // Mon=1 … Fri=5
  const isFriday = wd === 5;
  const afterClose = etMinutes == null || etMinutes >= 15 * 60 + 30;
  if (!opts.force && !(isFriday && afterClose)) {
    return loadAiTraderLeague();
  }
  const weekStart = weekStartMonday(etDay);
  const prev = await loadAiTraderLeague();
  if (!opts.force && prev?.weekStart === weekStart && prev.winner != null) return prev;
  const doc = buildLeagueScore(closed, now, { forceWeekStart: weekStart });
  // Keep prior activeTrader if this week has no winner yet.
  if (!doc.winner && prev?.activeTrader) {
    doc.activeTrader = prev.activeTrader;
    doc.note = `${doc.note} Keeping prior active trader: ${AI_TRADER_LABEL[prev.activeTrader]}.`;
  }
  await kvSet(K_LEAGUE, doc, { tier: "rare", ttlSec: 120 * 86400 });
  return doc;
}

export function traderBookId(trader: AiTraderId): AiTraderBookId {
  return AI_TRADER_BOOK[trader];
}

export function traderFromBook(book: AiTraderBookId): AiTraderId {
  return AI_TRADER_FROM_BOOK[book];
}

export function aiTraderSpreadMax(): number {
  return AI_TRADER_SPREAD_MAX_PCT;
}

export { AI_TRADERS, AI_TRADER_LABEL, AI_TRADER_BOOK, AI_TRADER_MAX_PICKS };
