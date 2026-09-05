import type { FlowAlert } from "@/lib/types";
import { scoreAlert } from "@/lib/scoring";
import { tideFromPremiums } from "@/lib/numbers";
import { evaluateWatch, makeAdverseWatch } from "@/lib/price-watches";
import type { HistoricBar } from "@/lib/follow-through";

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

function muClassSweep(now: Date): FlowAlert {
  return {
    ...freshMorningSweep(now),
    id: "study-mu-1060c",
    ticker: "MU",
    type: "call",
    strike: "1060",
    expiry: "2026-09-18",
    price: "18.40",
    bid: "18.20",
    ask: "18.50",
    underlying_price: "1048",
    created_at: new Date(now.getTime() - 45 * 60_000).toISOString(),
    all_opening_trades: false,
    option_chain: "MU260918C01060000",
    total_ask_side_prem: "620000",
    total_bid_side_prem: "40000",
    total_premium: "680000",
    volume_oi_ratio: "2.10",
  };
}

function sameDayAskSweepTide(id: string, hoursAgo: number, now: Date, extra: Partial<FlowAlert> = {}): FlowAlert {
  const created = new Date(now.getTime() - hoursAgo * 3_600_000);
  return {
    ...muClassSweep(now),
    id,
    created_at: created.toISOString(),
    all_opening_trades: false,
    has_sweep: true,
    ...extra,
  };
}

function tslaPut(strike: string, expiry: string, createdAt: string, spot: string, id: string): FlowAlert {
  return {
    id,
    ticker: "TSLA",
    type: "put",
    strike,
    expiry,
    price: "8.20",
    bid: "8.10",
    ask: "8.30",
    underlying_price: spot,
    created_at: createdAt,
    alert_rule: "RepeatedHits",
    all_opening_trades: false,
    has_floor: false,
    has_multileg: false,
    has_singleleg: true,
    has_sweep: true,
    issue_type: "Common Stock",
    marketcap: 1_100_000_000_000,
    open_interest: 4200,
    option_chain: `TSLA${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}P${String(Math.round(Number(strike) * 1000)).padStart(8, "0")}`,
    total_ask_side_prem: "410000",
    total_bid_side_prem: "28000",
    total_premium: "448000",
    total_size: 540,
    trade_count: 16,
    volume: 9800,
    volume_oi_ratio: "2.33",
  };
}

/** Local-only fixtures for Sep 4 study deltas. Does not call Unusual Whales. */
export function scoreStudyFixtures(now = new Date()) {
  const tide = tideFromPremiums(4_800_000, 1_200_000, now.toISOString());
  const closeFri = new Date("2026-09-04T20:00:00-04:00");
  const agedCall = {
    ...ypfAug17FloorAlert(),
    id: "study-mmm-class-floor",
    ticker: "MMM",
    strike: "190",
    expiry: "2026-09-18",
    created_at: "2026-09-04T10:00:00-04:00",
    option_chain: "MMM260918C00190000",
    underlying_price: "155",
  };

  const muFresh = muClassSweep(closeFri);
  const oneAndDone = sameDayAskSweepTide("study-one-done", 5, closeFri, {
    ticker: "SNDK",
    type: "put",
    strike: "1700",
    expiry: "2026-09-18",
    option_chain: "SNDK260918P01700000",
    underlying_price: "1680",
  });
  const confirmed = sameDayAskSweepTide("study-confirmed", 5, closeFri, {
    ticker: "INTC",
    strike: "99",
    expiry: "2026-09-18",
    option_chain: "INTC260918C00099000",
    underlying_price: "97.40",
  });
  const laterConfirm: FlowAlert = {
    ...confirmed,
    id: "study-confirmed-later",
    created_at: new Date(closeFri.getTime() - 90 * 60_000).toISOString(),
    price: "20.10",
    total_ask_side_prem: "62000",
    total_bid_side_prem: "5000",
    total_premium: "67000",
  };

  const morningNow = new Date("2026-09-04T10:55:00-04:00");
  const putTide = tideFromPremiums(1_200_000, 4_800_000, morningNow.toISOString());
  const tsla350 = tslaPut("350", "2026-09-11", "2026-09-04T10:20:00-04:00", "348", "study-tsla-350p");
  const tsla360 = tslaPut("360", "2026-09-11", "2026-09-04T10:20:00-04:00", "348", "study-tsla-360p");
  const tsla360sep9 = tslaPut("360", "2026-09-09", "2026-09-04T10:20:00-04:00", "348", "study-tsla-360p-sep9");

  const mmmWatch = makeAdverseWatch({
    ticker: "MMM",
    option_chain: "MMM260918C00190000",
    strike: "190",
    expiry: "2026-09-18",
    type: "call",
    entryPremium: 4.2,
    lastFlowPrint: 0.08,
  });
  mmmWatch.createdAt = "2026-09-03T14:10:00-04:00";

  const ghWatch = makeAdverseWatch({
    ticker: "GH",
    option_chain: "GH260918P00150000",
    strike: "150",
    expiry: "2026-09-18",
    type: "put",
    entryPremium: 6.4,
    lastFlowPrint: 9.8,
  });
  ghWatch.createdAt = "2026-09-03T11:40:00-04:00";

  const fadedHist: HistoricBar[] = [
    {
      date: "2026-09-03",
      last: 4.1,
      open: 4.0,
      high: 4.4,
      low: 3.9,
      askVolume: 800,
      bidVolume: 200,
      sweepVolume: 120,
      impliedVolatility: 0.42,
      ivHigh: 0.48,
      ivLow: 0.4,
      openInterest: 2100,
      totalPremium: 180000,
      volume: 1000,
      lastTapeTime: "2026-09-03T20:00:00Z",
      nbboBid: 4.0,
      nbboAsk: 4.2,
    },
    {
      date: "2026-09-04",
      last: 0.08,
      open: 3.9,
      high: 4.0,
      low: 0.06,
      askVolume: 40,
      bidVolume: 900,
      sweepVolume: 0,
      impliedVolatility: 0.28,
      ivHigh: 0.4,
      ivLow: 0.26,
      openInterest: 2100,
      totalPremium: 12000,
      volume: 940,
      lastTapeTime: "2026-09-04T20:00:00Z",
      nbboBid: 0.05,
      nbboAsk: 0.12,
    },
  ];
  const ghHist: HistoricBar[] = [
    {
      date: "2026-09-03",
      last: 6.5,
      open: 6.2,
      high: 6.8,
      low: 6.1,
      askVolume: 400,
      bidVolume: 180,
      sweepVolume: 90,
      impliedVolatility: 0.55,
      ivHigh: 0.6,
      ivLow: 0.5,
      openInterest: 800,
      totalPremium: 90000,
      volume: 580,
      lastTapeTime: "2026-09-03T20:00:00Z",
      nbboBid: 6.4,
      nbboAsk: 6.6,
    },
    {
      date: "2026-09-04",
      last: 9.85,
      open: 6.7,
      high: 10.2,
      low: 6.6,
      askVolume: 720,
      bidVolume: 210,
      sweepVolume: 180,
      impliedVolatility: 0.62,
      ivHigh: 0.68,
      ivLow: 0.52,
      openInterest: 800,
      totalPremium: 140000,
      volume: 930,
      lastTapeTime: "2026-09-04T20:00:00Z",
      nbboBid: 9.7,
      nbboAsk: 10.0,
    },
  ];

  return {
    agedSameSession: scoreAlert(agedCall, { now: closeFri }),
    staleYpf: scoreAlert(ypfAug17FloorAlert(), { now: closeFri }),
    freshSweep: scoreAlert(freshMorningSweep(closeFri), { now: closeFri, marketTide: tide }),
    muClassFresh: scoreAlert(muFresh, { now: closeFri, marketTide: tide }),
    oneAndDone: scoreAlert(oneAndDone, { now: closeFri, marketTide: tide, peers: [] }),
    oneAndDoneConfirmed: scoreAlert(confirmed, {
      now: closeFri,
      marketTide: tide,
      peers: [laterConfirm],
    }),
    tsla350: scoreAlert(tsla350, { now: morningNow, marketTide: putTide }),
    tsla360: scoreAlert(tsla360, { now: morningNow, marketTide: putTide }),
    tsla360sep9: scoreAlert(tsla360sep9, { now: morningNow, marketTide: putTide }),
    mmmWatch: evaluateWatch(
      mmmWatch,
      { last: 3.95, bid: 3.9, ask: 4.0, asOf: closeFri.toISOString(), quality: "uw_last" },
      { historic: fadedHist, now: closeFri },
    ),
    ghWatch: evaluateWatch(
      ghWatch,
      { last: 9.85, bid: 9.7, ask: 10.0, asOf: closeFri.toISOString(), quality: "uw_last" },
      { historic: ghHist, now: closeFri },
    ),
  };
}
