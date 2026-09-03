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

export type FlowResponse = {
  source: "live" | "mock";
  fetchedAt: string;
  unusual: boolean;
  tide: TideSnapshot | null;
  items: RankedFlow[];
  rawCount: number;
  warning?: string;
};

export type DailyPick = RankedFlow & {
  thesis: string;
  fadeRisks: string[];
};

export type PicksResponse = {
  source: "live" | "mock";
  fetchedAt: string;
  picks: DailyPick[];
  tide: TideSnapshot | null;
  warning?: string;
};

export type PriceWatchKind = "adverse" | "entry_approach";

export type PriceWatchStatus = "ok" | "approaching" | "adverse";

export type WatchDataQuality = "uw_last" | "uw_nbbo" | "flow_print";

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
};

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
  hint: "consider cutting" | "approaching entry";
  dataQuality: WatchDataQuality;
};

export type WatchCheckResponse = {
  checkedAt: string;
  evaluations: EvaluatedWatch[];
  alerts: WatchAlert[];
};
