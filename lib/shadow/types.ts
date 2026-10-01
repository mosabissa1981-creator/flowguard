/**
 * Shadow-mode analysis modules. They annotate candidates and log verdicts; they never change the
 * live pick lists (morning / picks / premove / ai-picks). The daily study book scores them.
 */

export type ShadowModuleId =
  | "news_x_check"
  | "earnings_check"
  | "debate"
  | "same_buyer_tracking"
  | "worth_the_price"
  | "x_sentiment_shift"
  | "regime_analogs"
  | "adaptive_exits";

export const SHADOW_MODULES: ShadowModuleId[] = [
  "news_x_check",
  "x_sentiment_shift",
  "earnings_check",
  "same_buyer_tracking",
  "worth_the_price",
  "regime_analogs",
  "adaptive_exits",
  "debate",
];

/** pass = no objection; flag = module objects; boost = module likes it; skip = module could not judge. */
export type ShadowVerdictKind = "pass" | "flag" | "skip" | "boost";

export type ShadowVerdict = {
  module: ShadowModuleId;
  verdict: ShadowVerdictKind;
  /** Module-specific signed score (e.g. sigma ratio, persistence count). Null when not applicable. */
  score: number | null;
  /** 0–100 confidence in the verdict. */
  confidence: number;
  reason: string;
  /** When the verdict was produced (ISO). */
  at: string;
  data?: Record<string, unknown>;
};

/** Frozen facts about a candidate at the time it was first seen today (joins to the study book by option_chain). */
export type ShadowCandidate = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  score: number;
  rawScore: number;
  lanes: string[];
  printTimeUtc: string;
  optionPrint: number;
  underlying: number;
  premiumUsd: number;
  askSharePct: number;
  chips: string[];
  firstSeenAt: string;
  /** Current fixed exit plan (for adaptive_exits comparison). */
  exitPlan?: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; sessions: number; timeStopDate: string };
};

export type LlmUsageRecord = {
  module: string;
  at: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  webSearchCalls: number;
  xSearchCalls: number;
  xPostsFetched: number;
  /** Provider-reported cost when available (xAI cost_in_usd_ticks), else estimated from list prices. */
  costUsd: number;
  costSource: "provider" | "estimate";
  ms: number;
};

export type ShadowRegimeFeatures = {
  label: string | null;
  us10yChangeBp: number | null;
  us30yChangeBp: number | null;
  tide: string | null;
  calendarType: string;
  eventsToday: string[];
  dayRating: string | null;
};

export type ShadowDay = {
  day: string;
  mode: "shadow";
  note: string;
  generatedAt: string;
  updatedAt: string;
  regime: ShadowRegimeFeatures | null;
  candidates: ShadowCandidate[];
  /** contract -> verdicts (latest per module). */
  verdicts: Record<string, ShadowVerdict[]>;
  /** Module-level notes for the day (e.g. regime analog summary). */
  dayNotes: Partial<Record<ShadowModuleId, unknown>>;
  llm: {
    status: "ok" | "no-key" | "throttled" | "budget" | "off-hours" | "error" | "idle";
    lastRunAt: string | null;
    nextAllowedAt: string | null;
    lastError?: string;
    spendUsd: number;
    usage: LlmUsageRecord[];
  };
  uwCalls: number;
  /** Per-day caches so repeated runs do not re-bill LLM / UW. Stripped from the public view unless ?full=1. */
  cache: {
    news: Record<string, { at: string; data: NewsXResult }>;
    debate: Record<string, { at: string; data: DebateResult }>;
    info: Record<string, { at: string; data: TickerInfo | null }>;
    vol: Record<string, { at: string; data: VolStats | null }>;
    earnings: Record<string, { at: string; data: EarningsHistoryRow[] | null }>;
    historic: Record<string, { at: string; data: ContractBar[] | null }>;
  };
};

export type NewsXResult = {
  ticker: string;
  freshNews: string;
  newsAgeHours: number | null;
  catalystPublic: boolean;
  fadeRisk: "low" | "med" | "high";
  rumor: string;
  xChatter: "rising" | "flat" | "falling" | "unknown";
  xTone: "bull" | "bear" | "mixed" | "unknown";
  priceMovePct: number | null;
  sources: string[];
};

export type DebateResult = {
  contract: string;
  bull: string;
  bear: string;
  macro: string;
  judge: "take" | "pass" | "avoid";
  confidence: number;
  why: string;
};

export type TickerInfo = { nextEarningsDate: string | null; announceTime: string | null; sector: string | null; beta: number | null };
export type VolStats = { iv: number | null; ivRank: number | null; rv: number | null; ivLow: number | null; ivHigh: number | null };
export type EarningsHistoryRow = {
  reportDate: string;
  reportTime: string | null;
  source: string | null;
  expectedMovePct: number | null;
  postMove1dPct: number | null;
};
export type ContractBar = {
  date: string;
  volume: number;
  openInterest: number;
  askVolume: number;
  bidVolume: number;
  lastPrice: number | null;
  iv: number | null;
};

export type BriefDoc = {
  day: string;
  generatedAt: string;
  status: "ok" | "no-key" | "pending" | "error" | "budget";
  model?: string;
  usage?: LlmUsageRecord;
  error?: string;
  brief: {
    summary: string;
    riskTone: "risk-on" | "risk-off" | "mixed";
    overnight: string[];
    yields: string;
    reports: { timeEt: string; title: string; expectation: string }[];
    drivers: string[];
    watch: string[];
  } | null;
};

export type ReleaseRead = {
  event: string;
  releaseAt: string;
  generatedAt: string;
  status: "ok" | "error";
  model?: string;
  usage?: LlmUsageRecord;
  error?: string;
  read: {
    actual: string;
    forecast: string;
    previous: string;
    temperature: "hot" | "cool" | "inline" | "mixed";
    headline: string;
    marketReaction: string;
    implications: string[];
    deskNote: string;
  } | null;
};

export type ReleaseReadDoc = { day: string; updatedAt: string; reads: ReleaseRead[]; pending: string[] };
