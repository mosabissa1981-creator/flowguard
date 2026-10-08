import type { SpreadInfo, SpreadSkip } from "@/lib/spread-core";

export type OptionType = "call" | "put";

/** Raw Unusual Whales flow-alert row. Field names match the public API. */
export type FlowAlert = {
  alert_rule: string;
  all_opening_trades: boolean;
  ask: string;
  bid: string;
  created_at: string;
  expiry: string;
  has_floor: boolean;
  has_multileg: boolean;
  has_singleleg: boolean;
  has_sweep: boolean;
  id: string;
  issue_type: string;
  marketcap: number | null;
  open_interest: number;
  option_chain: string;
  price: string;
  strike: string;
  ticker: string;
  total_ask_side_prem: string;
  total_bid_side_prem: string;
  total_premium: string;
  total_size: number;
  trade_count: number;
  type: OptionType;
  underlying_price: string;
  volume: number;
  volume_oi_ratio: string;
};

export type ScoreChipKind = "boost" | "penalty";

export type ScoreChip = {
  id: string;
  label: string;
  kind: ScoreChipKind;
  delta: number;
  detail: string;
};

export type TideBias = "bullish" | "bearish" | "neutral";

export type TideSnapshot = {
  timestamp: string | null;
  netCallPremium: number;
  netPutPremium: number;
  netPremium: number;
  bias: TideBias;
};

export type NetPremTick = {
  date: string;
  tape_time: string;
  net_call_premium: string;
  net_put_premium: string;
  net_call_volume?: number;
  net_put_volume?: number;
  call_volume?: number;
  put_volume?: number;
};

export type HoldWindow = {
  label: string;
  line: string;
  exit: string;
};

export type RankedFlow = {
  rank: number;
  score: number;
  /** Unclamped score (can exceed 100). Breaks the 100-clamp ties on actionable lists. */
  rawScore?: number;
  chips: ScoreChip[];
  fadeProne: boolean;
  stale: boolean;
  dte: number;
  askShare: number;
  holdWindow: HoldWindow;
  marketTideBias: TideBias | null;
  tickerTideBias: TideBias | null;
  alert: FlowAlert;
};

export type FlowFilters = {
  minPremium: number;
  minDte: number;
  maxDte: number;
  side: "all" | "call" | "put";
  minConviction: number;
  unusual: boolean;
  strictAntiFade: boolean;
  ticker: string;
};

export type TapeSource = "live" | "mock" | "cached";

export type FlowResponse = {
  source: TapeSource;
  fetchedAt: string;
  unusual: boolean;
  tide: TideSnapshot | null;
  items: RankedFlow[];
  rawCount: number;
  warning?: string;
  quotaBlocked?: boolean;
  authFailed?: boolean;
  /** Full-session accumulator coverage (lib/session-tape). */
  session?: SessionInfo;
};

export type SessionInfo = {
  prints: number;
  fromIso: string | null;
  toIso: string | null;
  complete: boolean;
  holes: number;
  syncedAt: string | null;
  uwCallsToday: number;
  /** false = per-instance memory only (no Redis). */
  durable: boolean;
  scope: "session" | "window";
};

export type ExitPlan = {
  /** Option premium per share used as entry (flow print at alert time). */
  entry: number;
  entryBasis: "flow-print" | "ask-at-print";
  target: number;
  targetPct: number;
  stop: number;
  stopPct: number;
  timeStop: { date: string; sessions: number; rule: string };
  /** Ready-made levels for the price-alert routine. */
  alertLevels: { kind: "target" | "stop"; premium: number; pct: number }[];
  /** Scheduled macro events before expiry (elevated IV / crush risk). */
  eventRisk: string[];
  note: string;
};

export type DailyPick = RankedFlow & {
  thesis: string;
  fadeRisks: string[];
  exitPlan?: ExitPlan;
  /** LIVE spread gate: bid/ask/spread% at evaluation (status "unknown" = kept but tagged). */
  spread?: SpreadInfo;
};

export type RegimeBrief = {
  label: RegimeLabel;
  reasons: string[];
  rules: RegimeRules;
  lockout?: RegimeLockout;
  dayRating?: RegimeSnapshot["dayRating"];
};

/** Attached by boards that load the LIVE risk-off flag (lib/risk-off.ts). */
export type RiskOffBrief = {
  day: string;
  level: "primary" | "soft" | "none" | "unknown";
  provisional: boolean;
  oil: boolean;
  yield: boolean;
  qqqWeak: boolean;
  nSignals: number;
  banner: string | null;
  blockEtfPuts: boolean;
  note: string;
};

export type PicksResponse = {
  /** LIVE risk-off morning flag (when the board loaded it). */
  riskOff?: RiskOffBrief;
  source: TapeSource;
  fetchedAt: string;
  picks: DailyPick[];
  tide: TideSnapshot | null;
  warning?: string;
  quotaBlocked?: boolean;
  authFailed?: boolean;
  /** Macro regime applied when this list was built (absent if the regime feed failed). */
  regime?: RegimeBrief | null;
  /** Contracts removed by the issuer / sector concentration caps. */
  capDrops?: { option_chain: string; ticker: string; reason: string }[];
  /** LIVE spread gate: names excluded because bid-ask spread > SPREAD_MAX_PCT of mid ("Skipped: wide spread X%"). */
  spreadSkips?: SpreadSkip[];
};

export type MorningShortlistResponse = PicksResponse & {
  tradingDate: string;
  snapshotLabel: string;
  frozen: true;
};

export type PriceWatchKind = "adverse" | "entry_approach";

export type PriceWatchStatus = "ok" | "approaching" | "adverse" | "fading" | "expired";

export type WatchDataQuality = "uw_last" | "uw_nbbo" | "flow_print";

export type ArmingSource = "uw_last" | "uw_nbbo" | "session_print" | "alert";

export type ArmingPremium = {
  premium: number;
  source: ArmingSource;
  label: string;
  asOf: string | null;
  /** /api/quote only: live NBBO + last-trade detail when UW answered. */
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  /** /api/quote only: why the live UW quote was not used (shown only on session_print / alert fallbacks). */
  diag?: { session: "open" | "closed"; steps: string[]; circuit?: { open: boolean; until: string | null; reason: string | null } };
};

/** Options-only price watch. Premiums are per-share option prices, not flow notional. */
export type PriceWatch = {
  id: string;
  kind: PriceWatchKind;
  ticker: string;
  option_chain: string;
  strike: string;
  expiry: string;
  type: OptionType;
  /** Fill (adverse) or suggested/target entry (entry_approach). */
  referencePremium: number;
  /** How the reference was chosen at arm time. */
  referenceSource?: ArmingSource;
  /** Adverse default 0.15. Ignored for entry watches. */
  adversePct: number;
  /** Entry default 0.05. Ignored for position watches. */
  approachPct: number;
  /** Optional hard stop on option premium (position watches). */
  stopPremium?: number;
  /** Last flow print at create/check time — quote fallback. */
  lastFlowPrint?: number;
  createdAt: string;
};

export type WatchQuote = {
  last: number;
  bid: number | null;
  ask: number | null;
  /** NBBO midpoint when both sides are live. */
  mid?: number | null;
  asOf: string | null;
  quality: WatchDataQuality;
};

export type EvaluatedWatch = {
  watch: PriceWatch;
  quote: WatchQuote | null;
  status: PriceWatchStatus;
  pctMove: number | null;
  hint: string | null;
  expired?: boolean;
  fading?: boolean;
};

export type WatchAlertHint =
  | "consider cutting"
  | "approaching entry"
  | "thesis fading"
  | "watch expired";

export type WatchAlert = {
  watchId: string;
  ticker: string;
  contract: string;
  option_chain: string;
  type: PriceWatchKind;
  last: number;
  reference: number;
  pctMove: number;
  status: Exclude<PriceWatchStatus, "ok">;
  hint: WatchAlertHint;
  dataQuality: WatchDataQuality;
};

export type WatchCheckResponse = {
  checkedAt: string;
  evaluations: EvaluatedWatch[];
  alerts: WatchAlert[];
  /** Armed ids deleted from the server store this check. */
  removedIds?: string[];
};

export type RegimeLabel = "calm" | "risky" | "report-day";

export type EconEvent = {
  title: string;
  country: string;
  /** ISO with offset, as published. */
  date: string;
  impact: "High" | "Medium" | "Low" | "Holiday" | string;
  forecast: string;
  previous: string;
};

export type YieldMove = {
  symbol: "US10Y" | "US30Y";
  /** Percent, e.g. 5.29 */
  last: number | null;
  prevClose: number | null;
  /** Basis points vs prior close. */
  changeBp: number | null;
  asOf: string | null;
  /** treasury = official daily par curve; treasury+yahoo = intraday last vs official prior close. */
  source: "yahoo" | "treasury" | "treasury+yahoo" | "none";
};

export type LockoutWindow = { start: string; end: string; event: string };

export type RegimeLockout = {
  /** True while a major release window is open — no new picks. */
  active: boolean;
  until: string | null;
  event: string | null;
  windows: LockoutWindow[];
};

export type RegimeRules = {
  /** True on risky / report-day. */
  active: boolean;
  /** Max contracts per actionable list (morning / picks / premove). */
  maxShortlist: number;
  /** Contracts below this DTE are dropped from actionable lists. 0 = no floor. */
  minDte: number;
  /** Score delta for calls on long-duration tech when long yields are rising (≤ 0). */
  rateTechPenalty: number;
  /** Score delta for calls on rate-sensitive sectors (utilities, REITs, homebuilders, IWM, KRE, long bonds) when long yields rise. */
  rateSensitivePenalty: number;
};

export type RegimeSnapshot = {
  label: RegimeLabel;
  tradingDate: string;
  fetchedAt: string;
  reasons: string[];
  rules: RegimeRules;
  events: {
    /** USD high-impact (and key medium) events on the trading date, ET. */
    today: EconEvent[];
    /** Next USD high-impact events after today (this week). */
    upcoming: EconEvent[];
  };
  yields: {
    us10y: YieldMove;
    us30y: YieldMove;
    rising: boolean;
    /** Official Treasury closes, last 5 sessions. */
    trend5d: { us2yBp: number | null; us10yBp: number | null; us30yBp: number | null; bearSteepening: boolean } | null;
  };
  /** Researched day rating (seed calendar), when one exists for the date. */
  dayRating: { rating: "good" | "careful" | "careful-afternoon" | "sit-out"; note: string } | null;
  lockout: RegimeLockout;
  /** Treasury 10Y/20Y/30Y auction today (afternoon = careful). */
  auctionToday: string | null;
  /** Scheduled vol events (CPI/PPI/NFP/FOMC) in the next ~45 days — expiries spanning them carry elevated IV. */
  ivEvents: { date: string; title: string }[];
  tide: TideSnapshot | null;
  sources: {
    calendar: "forexfactory" | "uw" | "unavailable";
    yields: "yahoo" | "treasury" | "treasury+yahoo" | "unavailable";
    tide: "uw-cache" | "uw" | "unavailable";
  };
  warnings: string[];
};

export type AiPick = DailyPick & {
  /** 0–100 */
  confidence: number;
  aiReason: string;
  lanes: string[];
  exitPlan: ExitPlan;
};

export type AiSkip = {
  option_chain: string;
  ticker: string;
  reason: string;
};

export type AiPremoveReview = {
  picks: AiPick[];
  skips: AiSkip[];
  candidatesConsidered: number;
  maxPicks: number;
  warning?: string;
};

export type StudySummaryBrief = {
  since: string;
  through: string | null;
  totals: { w: number; l: number; flat: number };
  buckets: Record<string, { w: number; l: number; flat: number }>;
  correlatedLossClusters: { day: string; issuer: string; n: number; losers: number; winners: number }[];
  lessons: string[];
};

export type AiPicksResponse = {
  /** LIVE risk-off morning flag. */
  riskOff?: RiskOffBrief;
  source: TapeSource;
  fetchedAt: string;
  generatedAt: string;
  engine: "llm" | "deterministic";
  llmStatus: "ok" | "no-key" | "error" | "invalid-output" | "skipped" | "throttled";
  llmProvider?: string;
  llmModel?: string;
  llmError?: string;
  /** Token usage reported by the provider for the call that produced this answer. */
  llmUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number; costUsd?: number };
  /** AI-review LLM spend so far today (USD) and the daily cap (AI_PICKS_DAILY_USD, default $1). */
  llmSpendTodayUsd?: number;
  llmBudgetUsd?: number;
  /** Set when the response is a stored LLM answer (cost guard) rather than a fresh call. */
  llmCachedAt?: string;
  /** Earliest time the cost guard allows the next LLM call. */
  nextLlmAt?: string;
  /** True when candidates changed since the stored LLM answer (refresh pending the throttle). */
  candidatesChanged?: boolean;
  regime: RegimeBrief | null;
  picks: AiPick[];
  skips: AiSkip[];
  candidatesConsidered: number;
  /** Separate review of the Premove ("Before the move") lane, produced by the same LLM call. */
  premove?: AiPremoveReview;
  study: StudySummaryBrief | null;
  warning?: string;
  quotaBlocked?: boolean;
  disclaimer: string;
  /** LIVE spread gate: names kept out of the AI finalists (morning / picks / premove) for spread > SPREAD_MAX_PCT. */
  spreadSkips?: SpreadSkip[];
};
