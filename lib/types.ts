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
};

export type DailyPick = RankedFlow & {
  thesis: string;
  fadeRisks: string[];
};

export type PicksResponse = {
  source: TapeSource;
  fetchedAt: string;
  picks: DailyPick[];
  tide: TideSnapshot | null;
  warning?: string;
  quotaBlocked?: boolean;
  authFailed?: boolean;
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

/** Research-only congressional disclosure. Never an input to picks or conviction. */
export type CongressSide = "buy" | "sell" | "all";

export type CongressTxnSide = "buy" | "sell" | "other";

export type CongressTrade = {
  id: string;
  name: string;
  ticker: string;
  txnType: string;
  side: CongressTxnSide;
  amounts: string;
  /** Disclosed trade date (YYYY-MM-DD). Often older than the filing. */
  transactionDate: string;
  /** STOCK Act filing date (YYYY-MM-DD). This is the window and sort key. */
  filedAtDate: string;
  memberType: string | null;
  issuer: string | null;
  politicianId: string | null;
};

export type CongressStatus = "ok" | "missing_key" | "quota" | "auth" | "error";

export type CongressQuery = {
  limit: number;
  side: CongressSide;
  ticker: string | null;
  days: number;
  /** Single UW market date. When set, the week window is not applied. */
  date: string | null;
};

export type CongressResponse = {
  source: "live" | "empty";
  status: CongressStatus;
  message: string;
  fetchedAt: string;
  /** Window and sort use this field. Transaction date is display-only. */
  dateField: "filed_at_date";
  endpoint: "/api/congress/recent-trades";
  windowDays: number;
  windowStart: string | null;
  windowEnd: string | null;
  datesQueried: string[];
  side: CongressSide;
  ticker: string | null;
  limit: number;
  contextOnly: true;
  scoring: "excluded";
  trades: CongressTrade[];
  warning?: string;
};
