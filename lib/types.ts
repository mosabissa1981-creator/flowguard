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

export type RankedFlow = {
  rank: number;
  score: number;
  chips: ScoreChip[];
  fadeProne: boolean;
  dte: number;
  askShare: number;
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
