import regimeDaysJson from "@/study/regime-days.json";
import candidateHistoryJson from "@/study/candidate-history.json";
import { bsPrice, impliedVol, sessionsToCalendarDays, spotForPremium } from "@/lib/shadow/bs";
import { HOLD_SESSIONS, TARGET_PCT } from "@/lib/exit-plan";
import type {
  ContractBar,
  EarningsHistoryRow,
  ShadowCandidate,
  ShadowRegimeFeatures,
  ShadowVerdict,
  TickerInfo,
  VolStats,
} from "@/lib/shadow/types";

/** Deterministic shadow modules (no LLM). Pure functions over cached UW data + committed study tables. */

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
const r2 = (x: number) => Math.round(x * 100) / 100;

function verdict(
  module: ShadowVerdict["module"],
  v: ShadowVerdict["verdict"],
  score: number | null,
  confidence: number,
  reason: string,
  data?: Record<string, unknown>,
): ShadowVerdict {
  return { module, verdict: v, score: score == null ? null : r2(score), confidence: Math.round(confidence), reason, at: new Date().toISOString(), data };
}

// ---------------------------------------------------------------- earnings_check
export function earningsCheck(c: ShadowCandidate, day: string, info: TickerInfo | null, hist: EarningsHistoryRow[] | null): ShadowVerdict {
  if (!info) return verdict("earnings_check", "skip", null, 0, "No UW ticker info (quota/ETF/unknown).");
  const next = info.nextEarningsDate;
  if (!next) return verdict("earnings_check", "pass", null, 60, "No scheduled earnings on file (ETF or not announced).");
  const expiry = c.expiry.slice(0, 10);
  if (next < day || next > expiry) {
    return verdict("earnings_check", "pass", null, 80, `Next earnings ${next} is ${next > expiry ? "after" : "before"} the ${expiry} expiry window.`, { nextEarningsDate: next });
  }
  const upcoming = (hist ?? []).find((h) => h.reportDate === next);
  const past = (hist ?? []).filter((h) => h.reportDate < day && h.postMove1dPct != null).slice(0, 8);
  const avgAbs = past.length ? past.reduce((s, h) => s + Math.abs(h.postMove1dPct as number), 0) / past.length : null;
  const implied = upcoming?.expectedMovePct ?? null;
  const parts = [`Earnings ${next}${info.announceTime && info.announceTime !== "unknown" ? ` (${info.announceTime})` : ""} before ${expiry} expiry`];
  if (implied != null) parts.push(`implied move ±${(implied * 100).toFixed(1)}%`);
  if (avgAbs != null) parts.push(`avg 1-day reaction ±${(avgAbs * 100).toFixed(1)}% (last ${past.length})`);
  parts.push("IV crush risk; time stop before the print unless the trade is the event");
  return verdict("earnings_check", "flag", implied ?? avgAbs, 85, parts.join(" — ") + ".", {
    nextEarningsDate: next,
    impliedMovePct: implied,
    avgAbsPostMove1dPct: avgAbs,
    reportsUsed: past.length,
  });
}

// ---------------------------------------------------------------- same_buyer_tracking
type HistDay = { c: string; s: number | null; a: number | null };
const CANDIDATE_HISTORY = (candidateHistoryJson as unknown as { days: Record<string, HistDay[]> }).days;

/** Prior study-day appearances of this contract (committed table + prior shadow days passed in). */
export function priorAppearances(contract: string, day: string, extra: Record<string, string[]> = {}): { day: string; score: number | null }[] {
  const out = new Map<string, number | null>();
  for (const [d, rows] of Object.entries(CANDIDATE_HISTORY)) {
    if (d >= day) continue;
    const hit = rows.find((r) => r.c === contract);
    if (hit) out.set(d, hit.s);
  }
  for (const [d, contracts] of Object.entries(extra)) {
    if (d < day && contracts.includes(contract) && !out.has(d)) out.set(d, null);
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, s]) => ({ day: d, score: s }));
}

export function sameBuyerTracking(c: ShadowCandidate, day: string, bars: ContractBar[] | null, prior: { day: string; score: number | null }[]): ShadowVerdict {
  const recentPrior = prior.filter((p) => p.day >= isoDaysBack(day, 10));
  const prev = (bars ?? []).filter((b) => b.date < day).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  if (!prev.length && !recentPrior.length) {
    return verdict("same_buyer_tracking", "skip", 0, 20, "No prior-session history for this contract (new listing, quota, or first appearance).");
  }
  const askDays = prev.filter((b) => b.volume >= 50 && b.askVolume > 1.3 * b.bidVolume);
  const bidDays = prev.filter((b) => b.volume >= 50 && b.bidVolume > 1.3 * b.askVolume);
  const oiNow = prev[0]?.openInterest ?? 0;
  const oiThen = prev[Math.min(prev.length - 1, 3)]?.openInterest ?? 0;
  const oiGrowth = oiThen > 0 ? oiNow / oiThen - 1 : null;
  const sizeVsAvg = prev.length ? c.premiumUsd / Math.max(1, (prev.reduce((s, b) => s + b.volume, 0) / prev.length) * c.optionPrint * 100) : null;
  const scores = recentPrior.map((p) => p.score).filter((s): s is number => s != null);
  const persistence = askDays.length + recentPrior.length;
  const data = {
    askAddDays5: askDays.length,
    bidDays5: bidDays.length,
    oiGrowthPct: oiGrowth == null ? null : Math.round(oiGrowth * 1000) / 10,
    priorStudyDays: recentPrior.map((p) => p.day),
    priorScores: scores,
    todayPremVsAvgDailyNotional: sizeVsAvg == null ? null : r2(sizeVsAvg),
  };
  const bits = [
    `${askDays.length}/${prev.length} prior sessions ask-dominant, ${bidDays.length} bid-heavy`,
    oiGrowth != null ? `OI ${pct(oiGrowth, 0)} over ${Math.min(prev.length - 1, 3)} sessions` : "OI n/a",
    recentPrior.length ? `on the study board ${recentPrior.length}x in 10d (${recentPrior.map((p) => p.day.slice(5)).join(", ")})` : "first study appearance",
  ];
  if ((askDays.length >= 2 && (oiGrowth ?? 0) > 0.1) || (recentPrior.length >= 2 && askDays.length >= 1)) {
    return verdict("same_buyer_tracking", "boost", persistence, 65, `Repeat buyer: ${bits.join("; ")}.`, data);
  }
  if (bidDays.length >= 2 && bidDays.length > askDays.length && (oiGrowth ?? 0) <= 0) {
    return verdict("same_buyer_tracking", "flag", -bidDays.length, 60, `Prior sessions bid-heavy with flat/shrinking OI (distribution): ${bits.join("; ")}.`, data);
  }
  return verdict("same_buyer_tracking", "pass", persistence, 45, `${bits.join("; ")}.`, data);
}

function isoDaysBack(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- worth_the_price
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function worthThePrice(c: ShadowCandidate, vol: VolStats | null, riskyRegime: boolean): ShadowVerdict {
  const S = c.underlying;
  const T = Math.max(1, c.dte) / 365;
  const ivPrint = impliedVol(c.optionPrint, S, c.strike, T, c.side) ?? vol?.iv ?? null;
  if (!ivPrint || !(S > 0)) return verdict("worth_the_price", "skip", null, 0, "Could not derive IV from the print.");
  const targetPct = c.exitPlan ? c.exitPlan.targetPct / 100 : TARGET_PCT;
  const sessions = c.exitPlan?.sessions ?? HOLD_SESSIONS;
  const Texit = Math.max(1, c.dte - sessionsToCalendarDays(sessions)) / 365;
  const target = c.optionPrint * (1 + targetPct);
  const Sstar = spotForPremium(target, S, c.strike, Texit, ivPrint, c.side);
  const realized = vol?.rv ?? null;
  const typicalVol = realized ?? vol?.iv ?? ivPrint;
  const sigmaHold = typicalVol * Math.sqrt(sessions / 252);
  if (Sstar == null) return verdict("worth_the_price", "skip", null, 0, "Target premium unreachable in the model.");
  const req = Sstar / S - 1;
  const ratio = Math.abs(req) / sigmaHold;
  const ivRank = vol?.ivRank ?? null;
  const ivVsRv = realized ? ivPrint / realized : null;
  const data = {
    ivAtPrint: r2(ivPrint),
    ivRank: ivRank == null ? null : Math.round(ivRank),
    rv: realized == null ? null : r2(realized),
    ivVsRv: ivVsRv == null ? null : r2(ivVsRv),
    targetPremium: r2(target),
    sessions,
    requiredUnderlying: r2(Sstar),
    requiredMovePct: Math.round(req * 1000) / 10,
    sigmaHoldPct: Math.round(sigmaHold * 1000) / 10,
    sigmaRatio: r2(ratio),
  };
  const cheap = ivRank != null ? (ivRank < 30 ? "IV cheap" : ivRank > 70 ? "IV rich" : "IV mid") : "IV rank n/a";
  const base = `Needs ${pct(req)} (to $${r2(Sstar)}) in ${sessions} session${sessions === 1 ? "" : "s"} for +${Math.round(targetPct * 100)}% vs 1σ ≈ ${(sigmaHold * 100).toFixed(1)}% (${realized ? "RV" : "IV"} ${(typicalVol * 100).toFixed(0)}%) → ${ratio.toFixed(2)}σ; ${cheap}${ivRank != null ? ` (rank ${Math.round(ivRank)})` : ""}${ivVsRv ? `, IV/RV ${ivVsRv.toFixed(2)}` : ""}.`;
  if (ratio > 1) return verdict("worth_the_price", "flag", ratio, 70, `Expensive ask: ${base}`, data);
  if (ivRank != null && ivRank > 80 && ratio > 0.8) return verdict("worth_the_price", "flag", ratio, 55, `Rich IV + stretched target: ${base}`, data);
  if (ratio < 0.6 && (ivRank == null || ivRank < 50)) return verdict("worth_the_price", "boost", ratio, 60, `Cheap for the move: ${base}`, data);
  return verdict("worth_the_price", "pass", ratio, 50, base, data);
}

// ---------------------------------------------------------------- adaptive_exits
export function adaptiveExits(c: ShadowCandidate, vol: VolStats | null, riskyRegime: boolean): ShadowVerdict {
  const S = c.underlying;
  const T = Math.max(1, c.dte) / 365;
  const iv = impliedVol(c.optionPrint, S, c.strike, T, c.side) ?? vol?.iv ?? null;
  if (!iv || !(S > 0) || !(c.optionPrint > 0)) return verdict("adaptive_exits", "skip", null, 0, "No IV — cannot scale exits.");
  const typicalVol = vol?.rv ?? vol?.iv ?? iv;
  const maxSessions = riskyRegime ? 3 : 5;
  const sessions = Math.max(2, Math.min(maxSessions, Math.round(c.dte / 4)));
  const sigmaHold = typicalVol * Math.sqrt(sessions / 252);
  const dir = c.side === "call" ? 1 : -1;
  const Texit = Math.max(1, c.dte - sessionsToCalendarDays(sessions)) / 365;
  const Thalf = Math.max(1, c.dte - sessionsToCalendarDays(Math.ceil(sessions / 2))) / 365;
  const tgtMove = riskyRegime ? 0.6 : 0.75;
  const valTarget = bsPrice(S * (1 + dir * tgtMove * sigmaHold), c.strike, Texit, iv, c.side);
  const valStop = bsPrice(S * (1 - dir * 0.5 * sigmaHold), c.strike, Thalf, iv, c.side);
  const targetPct = Math.min(1.5, Math.max(0.15, valTarget / c.optionPrint - 1));
  const stopPct = Math.max(-0.5, Math.min(-0.15, valStop / c.optionPrint - 1));
  const cur = c.exitPlan;
  const adaptive = {
    target: r2(c.optionPrint * (1 + targetPct)),
    targetPct: Math.round(targetPct * 100),
    stop: r2(c.optionPrint * (1 + stopPct)),
    stopPct: Math.round(stopPct * 100),
    sessions,
    basis: `${tgtMove}σ favorable by time stop / 0.5σ adverse by half-time; σ from ${vol?.rv ? "UW realized vol" : "IV"} ${(typicalVol * 100).toFixed(0)}%`,
  };
  const data = { current: cur ?? null, adaptive };
  const curTgt = cur?.targetPct ?? (riskyRegime ? 30 : 40);
  const line = `Adaptive: +${adaptive.targetPct}% / ${adaptive.stopPct}% / ${sessions} sessions vs fixed +${curTgt}% / ${cur?.stopPct ?? -25}% / ${cur?.sessions ?? "?"} sessions.`;
  if (adaptive.targetPct < curTgt * 0.6) return verdict("adaptive_exits", "flag", adaptive.targetPct, 50, `Fixed target is ambitious for this name's typical move. ${line}`, data);
  if (adaptive.targetPct > curTgt * 1.5) return verdict("adaptive_exits", "boost", adaptive.targetPct, 50, `Typical move supports a wider target. ${line}`, data);
  return verdict("adaptive_exits", "pass", adaptive.targetPct, 50, line, data);
}

// ---------------------------------------------------------------- regime_analogs
type RegimeDay = {
  day: string;
  label: string | null;
  tide: string | null;
  us10yChangeBp: number | null;
  us30yChangeBp: number | null;
  calendarType: string;
  types: Record<string, { w: number; l: number; flat: number }>;
};
const REGIME_DAYS = (regimeDaysJson as unknown as { days: RegimeDay[] }).days;

export function dteBand(dte: number): string {
  return dte <= 10 ? "dte0-10" : dte <= 30 ? "dte11-30" : "dte31+";
}

export function calendarTypeOf(eventsToday: string[]): string {
  if (eventsToday.some((e) => /FOMC Statement|Federal Funds|Rate Decision/i.test(e))) return "fomc";
  if (eventsToday.some((e) => /Non-?Farm|CPI|Consumer Price|PPI|Producer Price|PCE|GDP|ISM|Retail Sales|Employment/i.test(e))) return "report";
  return "normal";
}

export type AnalogSummary = {
  today: ShadowRegimeFeatures | null;
  analogs: { day: string; distance: number; tide: string | null; us10yChangeBp: number | null; calendarType: string; record: string }[];
  byType: Record<string, { w: number; l: number; flat: number }>;
  note: string;
};

export function regimeAnalogs(today: ShadowRegimeFeatures | null, day: string, k = 4): AnalogSummary {
  const pool = REGIME_DAYS.filter((d) => d.day < day && Object.keys(d.types).length);
  if (!today || !pool.length) return { today, analogs: [], byType: {}, note: "No regime or no prior study days." };
  const dist = (d: RegimeDay) => {
    let x = 0;
    x += d.tide && today.tide ? (d.tide === today.tide ? 0 : 1) : 0.5;
    x += d.us10yChangeBp != null && today.us10yChangeBp != null ? Math.min(2, Math.abs(d.us10yChangeBp - today.us10yChangeBp) / 4) : 0.75;
    x += d.calendarType === today.calendarType ? 0 : 0.75;
    if (d.label && today.label) x += d.label === today.label ? 0 : 0.5;
    return Math.round(x * 100) / 100;
  };
  const ranked = pool.map((d) => ({ d, dist: dist(d) })).sort((a, b) => a.dist - b.dist || b.d.day.localeCompare(a.d.day)).slice(0, k);
  const byType: Record<string, { w: number; l: number; flat: number }> = {};
  for (const { d } of ranked) {
    for (const [key, v] of Object.entries(d.types)) {
      const t = (byType[key] ||= { w: 0, l: 0, flat: 0 });
      t.w += v.w;
      t.l += v.l;
      t.flat += v.flat;
    }
  }
  const best = Object.entries(byType)
    .filter(([, v]) => v.w + v.l + v.flat >= 3)
    .sort((a, b) => b[1].w / (b[1].w + b[1].l + b[1].flat) - a[1].w / (a[1].w + a[1].l + a[1].flat))
    .slice(0, 3)
    .map(([key, v]) => `${key} ${v.w}W/${v.l}L/${v.flat}F`);
  return {
    today,
    analogs: ranked.map(({ d, dist: x }) => {
      const tot = Object.values(d.types).reduce((s, v) => ({ w: s.w + v.w, l: s.l + v.l, f: s.f + v.flat }), { w: 0, l: 0, f: 0 });
      return { day: d.day, distance: x, tide: d.tide, us10yChangeBp: d.us10yChangeBp, calendarType: d.calendarType, record: `${tot.w}W/${tot.l}L/${tot.f}F` };
    }),
    byType,
    note: `Closest days ${ranked.map((r) => r.d.day.slice(5)).join(", ")}; best types: ${best.join("; ") || "none with n≥3"}.`,
  };
}

export function regimeAnalogVerdict(c: ShadowCandidate, summary: AnalogSummary): ShadowVerdict {
  if (!summary.analogs.length) return verdict("regime_analogs", "skip", null, 0, summary.note);
  const bucket = c.lanes.includes("morning") ? "morning" : "other";
  const key = `${c.side}|${dteBand(c.dte)}|${bucket}`;
  const t = summary.byType[key];
  const days = summary.analogs.map((a) => a.day.slice(5)).join(", ");
  if (!t || t.w + t.l + t.flat < 3) {
    return verdict("regime_analogs", "pass", null, 30, `Too few ${key} rows on analog days (${days}).`, { key, analogDays: days });
  }
  const n = t.w + t.l + t.flat;
  const winRate = t.w / n;
  const lossRate = t.l / n;
  const rec = `${key} on analog days (${days}): ${t.w}W/${t.l}L/${t.flat}F`;
  if (t.w >= 2 && winRate >= 0.3 && t.w > t.l) return verdict("regime_analogs", "boost", winRate, 55, `${rec} — this type worked.`, { key, ...t });
  if (t.w === 0 || lossRate >= 0.4 || t.l >= t.w + 2) return verdict("regime_analogs", "flag", -lossRate, 55, `${rec} — this type failed in similar regimes.`, { key, ...t });
  return verdict("regime_analogs", "pass", winRate - lossRate, 40, `${rec}.`, { key, ...t });
}
