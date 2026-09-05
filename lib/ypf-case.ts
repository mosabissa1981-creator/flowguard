import type { FlowAlert } from "@/lib/types";
import { scoreAlert } from "@/lib/scoring";
import { tideFromPremiums } from "@/lib/numbers";

/** The Aug 17 YPF floor alert that was still a top Pick on Sep 3 before session + age fixes. */
export function ypfAug17FloorAlert(): FlowAlert {
  return {
    id: "ypf-aug17-floor",
    ticker: "YPF",
    type: "call",
    strike: "55",
    expiry: "2026-10-16",
    price: "2.20",
    bid: "2.15",
    ask: "2.20",
    underlying_price: "51.71",
    created_at: "2026-08-17T14:35:43.067447Z",
    alert_rule: "LowHistoricVolumeFloor",
    all_opening_trades: true,
    has_floor: true,
    has_multileg: false,
    has_singleleg: true,
    has_sweep: false,
    issue_type: "Common Stock",
    marketcap: 20_000_000_000,
    open_interest: 2740,
    option_chain: "YPF261016C00055000",
    total_ask_side_prem: "2200000",
    total_bid_side_prem: "0",
    total_premium: "2200000",
    total_size: 10000,
    trade_count: 4,
    volume: 10000,
    volume_oi_ratio: "3.65",
  };
}

/** Same-day bid-side follow-through on the YPF chain (selling into the fade). */
export function ypfAug17BidFollow(): FlowAlert {
  return {
    ...ypfAug17FloorAlert(),
    id: "ypf-aug17-bid",
    created_at: "2026-08-17T18:40:00.000Z",
    price: "2.55",
    total_ask_side_prem: "0",
    total_bid_side_prem: "180000",
    total_premium: "180000",
    has_floor: false,
    alert_rule: "RepeatedHits",
  };
}

/** Next-session dump on the same chain. */
export function ypfAug18FadePrint(): FlowAlert {
  return {
    ...ypfAug17FloorAlert(),
    id: "ypf-aug18-fade",
    created_at: "2026-08-18T14:10:00.000Z",
    price: "1.70",
    total_ask_side_prem: "12000",
    total_bid_side_prem: "88000",
    total_premium: "100000",
    has_floor: false,
    alert_rule: "RepeatedHits",
  };
}

/** Fresh same-morning ask-side sweep — must still score ≥ 70. */
export function freshMorningSweep(now = new Date()): FlowAlert {
  const expiry = new Date(now.getTime() + 21 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: "control-nvda-sweep",
    ticker: "NVDA",
    type: "call",
    strike: "180",
    expiry,
    price: "9.40",
    bid: "9.30",
    ask: "9.45",
    underlying_price: "176.20",
    created_at: new Date(now.getTime() - 12 * 60_000).toISOString(),
    alert_rule: "RepeatedHits",
    all_opening_trades: true,
    has_floor: false,
    has_multileg: false,
    has_singleleg: true,
    has_sweep: true,
    issue_type: "Common Stock",
    marketcap: 4_300_000_000_000,
    open_interest: 18420,
    option_chain: `NVDA${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}C00180000`,
    total_ask_side_prem: "1284000",
    total_bid_side_prem: "82000",
    total_premium: "1410000",
    total_size: 1500,
    trade_count: 28,
    volume: 61200,
    volume_oi_ratio: "3.32",
  };
}

/** Local-only fixtures for Sep 4 study deltas. Does not call Unusual Whales. */
export function scoreStudyFixtures(now = new Date()) {
  const tide = tideFromPremiums(4_800_000, 1_200_000, now.toISOString());
  const agedNow = new Date("2026-09-04T20:00:00-04:00");
  const agedCall = {
    ...ypfAug17FloorAlert(),
    id: "study-mmm-class-floor",
    ticker: "MMM",
    strike: "190",
    expiry: "2026-09-18",
    created_at: "2026-09-04T10:00:00-04:00",
    option_chain: "MMM260918C00190000",
  };
  return {
    agedSameSession: scoreAlert(agedCall, { now: agedNow }),
    staleYpf: scoreAlert(ypfAug17FloorAlert(), { now: agedNow }),
    freshSweep: scoreAlert(freshMorningSweep(agedNow), { now: agedNow, marketTide: tide }),
  };
}
