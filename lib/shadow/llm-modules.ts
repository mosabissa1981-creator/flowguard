import "server-only";

import { issuerKey } from "@/lib/issuers";
import { callShadowLlm, parseJsonObject } from "@/lib/shadow/llm";
import type { DebateResult, LlmUsageRecord, NewsXResult, ShadowCandidate, ShadowRegimeFeatures, ShadowVerdict } from "@/lib/shadow/types";

const etClock = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d) + " ET";

function v(module: ShadowVerdict["module"], verdict: ShadowVerdict["verdict"], score: number | null, confidence: number, reason: string, data?: Record<string, unknown>): ShadowVerdict {
  return { module, verdict, score, confidence: Math.round(confidence), reason: reason.slice(0, 300), at: new Date().toISOString(), data };
}

// ---------------------------------------------------------------- news_x_check + x_sentiment_shift (one batched search call)
export async function runNewsX(
  groups: { issuer: string; tickers: string[]; sides: string[]; priceFlat: boolean }[],
  now: Date,
): Promise<{ results: Record<string, NewsXResult>; usage: LlmUsageRecord }> {
  const from = new Date(now.getTime() - 36 * 3600_000).toISOString().slice(0, 10);
  const system = [
    "You are the news and social-chatter checker for an unusual-options-flow desk. Use web search and X search.",
    "For EACH issuer: (1) the freshest real news/catalyst in the last 24h before the as-of time (headline, age in hours);",
    "(2) whether the bullish/bearish option flow is chasing news that is ALREADY public (fade risk);",
    "(3) rumors circulating; (4) X chatter volume vs its normal (rising/flat/falling) and tone; (5) today's stock move % if known.",
    "Ignore anything published after the as-of time. Be terse; no speculation presented as fact.",
    'Return JSON only: {"issuers":[{"issuer":"","freshNews":"<=140 chars or none","newsAgeHours":number|null,"catalystPublic":true|false,',
    '"fadeRisk":"low|med|high","rumor":"<=100 chars or none","xChatter":"rising|flat|falling","xTone":"bull|bear|mixed","priceMovePct":number|null}]}',
  ].join(" ");
  const user = JSON.stringify({
    asOf: etClock(now),
    issuers: groups.map((g) => ({ issuer: g.issuer, tickers: g.tickers, flow: g.sides.join("/"), stockQuietToday: g.priceFlat })),
  });
  const res = await callShadowLlm({ module: "news_x_check+x_sentiment_shift", system, user, search: { web: true, x: true, fromDate: from, maxTurns: 2 } });
  const parsed = parseJsonObject<{ issuers?: Array<Record<string, unknown>> }>(res.text);
  const results: Record<string, NewsXResult> = {};
  for (const row of parsed?.issuers ?? []) {
    const name = String(row.issuer ?? "").toUpperCase();
    const g = groups.find((x) => x.issuer === name || x.tickers.includes(name) || name.split(/[/, ]+/).some((t) => x.tickers.includes(t)));
    if (!g) continue;
    const enumOf = <T extends string>(val: unknown, allowed: T[], dflt: T): T => (allowed.includes(String(val) as T) ? (String(val) as T) : dflt);
    results[g.issuer] = {
      ticker: g.issuer,
      freshNews: String(row.freshNews ?? "none").slice(0, 200),
      newsAgeHours: typeof row.newsAgeHours === "number" ? row.newsAgeHours : null,
      catalystPublic: row.catalystPublic === true,
      fadeRisk: enumOf(row.fadeRisk, ["low", "med", "high"], "med"),
      rumor: String(row.rumor ?? "none").slice(0, 160),
      xChatter: enumOf(row.xChatter, ["rising", "flat", "falling"], "unknown"),
      xTone: enumOf(row.xTone, ["bull", "bear", "mixed"], "unknown"),
      priceMovePct: typeof row.priceMovePct === "number" ? row.priceMovePct : null,
      sources: res.sources.slice(0, 6),
    };
  }
  return { results, usage: res.usage };
}

const isNone = (s: string) => !s || /^none\b|^n\/a|^no (fresh|new|news)/i.test(s.trim());

export function newsVerdict(c: ShadowCandidate, r: NewsXResult | undefined): ShadowVerdict {
  if (!r) return v("news_x_check", "skip", null, 0, "No news/X result (no key, throttled, or search failed).");
  const data = { freshNews: r.freshNews, newsAgeHours: r.newsAgeHours, catalystPublic: r.catalystPublic, fadeRisk: r.fadeRisk, rumor: r.rumor, sources: r.sources };
  const news = isNone(r.freshNews) ? "no fresh news" : `${r.freshNews}${r.newsAgeHours != null ? ` (${r.newsAgeHours}h)` : ""}`;
  const rumor = isNone(r.rumor) ? "" : `; rumor: ${r.rumor}`;
  if (r.fadeRisk === "high") {
    return v("news_x_check", "flag", -1, 65, `${r.catalystPublic ? "Flow chasing public news" : "High fade risk"}: ${news}${rumor}.`, data);
  }
  if (r.fadeRisk === "low" && (!isNone(r.rumor) || (!r.catalystPublic && !isNone(r.freshNews)))) {
    return v("news_x_check", "boost", 1, 55, `Catalyst not yet priced: ${news}${rumor}.`, data);
  }
  if (isNone(r.freshNews) && isNone(r.rumor)) return v("news_x_check", "pass", 0, 50, "No fresh catalyst — the flow itself is the information.", data);
  return v("news_x_check", "pass", 0, 45, `${news}${rumor} (fade risk ${r.fadeRisk}).`, data);
}

export function xSentimentVerdict(c: ShadowCandidate, r: NewsXResult | undefined): ShadowVerdict {
  if (!r || r.xChatter === "unknown") return v("x_sentiment_shift", "skip", null, 0, "No X chatter read.");
  const quiet = c.chips.some((ch) => ch.startsWith("quiet"));
  const flat = quiet || (r.priceMovePct != null && Math.abs(r.priceMovePct) < 1);
  const aligned = (c.side === "call" && r.xTone === "bull") || (c.side === "put" && r.xTone === "bear");
  const opposed = (c.side === "call" && r.xTone === "bear") || (c.side === "put" && r.xTone === "bull");
  const data = { xChatter: r.xChatter, xTone: r.xTone, priceMovePct: r.priceMovePct, priceFlat: flat };
  const desc = `X chatter ${r.xChatter}, tone ${r.xTone}, stock ${r.priceMovePct != null ? `${r.priceMovePct > 0 ? "+" : ""}${r.priceMovePct}%` : quiet ? "quiet" : "move n/a"}`;
  if (r.xChatter === "rising" && flat && aligned) return v("x_sentiment_shift", "boost", 1, 55, `Chatter accelerating while price is flat, aligned with the ${c.side}s: ${desc}.`, data);
  if (r.xChatter === "rising" && opposed) return v("x_sentiment_shift", "flag", -1, 50, `Chatter rising against the ${c.side}s: ${desc}.`, data);
  if (r.xChatter === "rising" && !flat) return v("x_sentiment_shift", "pass", 0, 40, `Chatter rising but price already moving: ${desc}.`, data);
  return v("x_sentiment_shift", "pass", 0, 40, `${desc}.`, data);
}

// ---------------------------------------------------------------- debate (bull / bear / macro + judge, one combined call)
export async function runDebate(
  cands: ShadowCandidate[],
  regime: ShadowRegimeFeatures | null,
  context: Record<string, string[]>,
  extra: { brief?: string | null; now: Date },
): Promise<{ results: Record<string, DebateResult>; usage: LlmUsageRecord }> {
  const system = [
    "You run a fast three-voice debate for each option-flow candidate, then judge. Voices: BULL (best case for the flow),",
    "BEAR (why it fails: fade, crowding, poor price, timing), MACRO (regime, yields, events, sector rates). Each voice <=140 chars,",
    "concrete and specific to the facts given. Then JUDGE: take | pass | avoid with confidence 0-100 and a <=140 char why.",
    "This is a shadow study, not advice; be calibrated — most candidates should be pass.",
    'Return JSON only: {"debates":[{"contract":"","bull":"","bear":"","macro":"","judge":"take|pass|avoid","confidence":0,"why":""}]}',
  ].join(" ");
  const user = JSON.stringify({
    asOf: etClock(extra.now),
    regime,
    premarketBrief: extra.brief ?? null,
    candidates: cands.map((c) => ({
      contract: c.contract,
      ticker: c.ticker,
      side: c.side,
      strike: c.strike,
      expiry: c.expiry,
      dte: c.dte,
      score: c.rawScore,
      lanes: c.lanes,
      print: c.optionPrint,
      underlying: c.underlying,
      premiumUsd: c.premiumUsd,
      askSharePct: c.askSharePct,
      chips: c.chips,
      otherModules: context[c.contract] ?? [],
    })),
  });
  const res = await callShadowLlm({ module: "debate", system, user });
  const parsed = parseJsonObject<{ debates?: Array<Record<string, unknown>> }>(res.text);
  const results: Record<string, DebateResult> = {};
  const keys = new Set(cands.map((c) => c.contract));
  for (const d of parsed?.debates ?? []) {
    const contract = String(d.contract ?? "").trim();
    if (!keys.has(contract)) continue;
    const judge = ["take", "pass", "avoid"].includes(String(d.judge)) ? (String(d.judge) as DebateResult["judge"]) : "pass";
    results[contract] = {
      contract,
      bull: String(d.bull ?? "").slice(0, 200),
      bear: String(d.bear ?? "").slice(0, 200),
      macro: String(d.macro ?? "").slice(0, 200),
      judge,
      confidence: Math.max(0, Math.min(100, Number(d.confidence) || 0)),
      why: String(d.why ?? "").slice(0, 200),
    };
  }
  return { results, usage: res.usage };
}

export function debateVerdict(r: DebateResult | undefined): ShadowVerdict {
  if (!r) return v("debate", "skip", null, 0, "No debate (no key, throttled, budget, or model error).");
  const kind = r.judge === "take" ? "boost" : r.judge === "avoid" ? "flag" : "pass";
  return v("debate", kind, r.judge === "take" ? 1 : r.judge === "avoid" ? -1 : 0, r.confidence, `Judge ${r.judge.toUpperCase()}: ${r.why}`, {
    bull: r.bull,
    bear: r.bear,
    macro: r.macro,
  });
}

export function issuerGroups(cands: ShadowCandidate[]): { issuer: string; tickers: string[]; sides: string[]; priceFlat: boolean }[] {
  const map = new Map<string, { issuer: string; tickers: string[]; sides: string[]; priceFlat: boolean }>();
  for (const c of cands) {
    const issuer = issuerKey(c.ticker);
    const g = map.get(issuer) ?? { issuer, tickers: [], sides: [], priceFlat: true };
    if (!g.tickers.includes(c.ticker)) g.tickers.push(c.ticker);
    if (!g.sides.includes(c.side)) g.sides.push(c.side);
    if (!c.chips.some((ch) => ch.startsWith("quiet"))) g.priceFlat = false;
    map.set(issuer, g);
  }
  return [...map.values()];
}
