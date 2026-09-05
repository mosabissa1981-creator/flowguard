/**
 * Reconstructed Fri 4 Sep 2026 study book.
 * No Unusual Whales calls. Fields are study-metadata fixtures, not live quotes.
 *
 * Named rows (16 outcomes + 6 named flats) come from study/lessons-2026-09-04.md
 * and the 4 Sep chat list. The other ~9 flats were “etc.” without ticker/strike —
 * represented once as a template, not invented names.
 */
import type { FlowAlert, OptionType } from "@/lib/types";
import { ypfAug17FloorAlert } from "@/lib/ypf-case";

export type BookLane = "morning_chat" | "morning" | "picks" | "watch" | "flat";
export type BookClass = "winner" | "loser" | "flat" | "no_quote";

export type BookRow = {
  id: string;
  label: string;
  outcomePct: number | null;
  cls: BookClass;
  lane: BookLane;
  sweep: boolean;
  tide: "aligned" | "unknown" | "none";
  allOpening: boolean;
  createdAt: string;
  armedAt?: string;
  followThrough: "pending" | "none" | "premium" | "later-ask";
  notes: string;
  alert: FlowAlert;
};

const CLOSE = "2026-09-04T20:00:00-04:00";
const MORNING = "2026-09-04T10:20:00-04:00";
const WATCH_SEP3 = "2026-09-03T14:10:00-04:00";

function chain(ticker: string, expiry: string, type: OptionType, strike: number): string {
  const y = expiry.slice(2, 4);
  const m = expiry.slice(5, 7);
  const d = expiry.slice(8, 10);
  const side = type === "call" ? "C" : "P";
  const strikeCode = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${ticker}${y}${m}${d}${side}${strikeCode}`;
}

function alert(partial: {
  id: string;
  ticker: string;
  type: OptionType;
  strike: string;
  expiry: string;
  created_at: string;
  has_sweep: boolean;
  all_opening_trades: boolean;
  has_floor?: boolean;
  underlying_price?: string;
  total_premium?: string;
  total_ask_side_prem?: string;
  total_bid_side_prem?: string;
  volume_oi_ratio?: string;
  price?: string;
  alert_rule?: string;
}): FlowAlert {
  const strikeN = Number(partial.strike);
  return {
    id: partial.id,
    ticker: partial.ticker,
    type: partial.type,
    strike: partial.strike,
    expiry: partial.expiry,
    price: partial.price ?? "8.00",
    bid: "7.90",
    ask: "8.10",
    underlying_price: partial.underlying_price ?? "",
    created_at: partial.created_at,
    alert_rule: partial.alert_rule ?? (partial.has_sweep ? "RepeatedHits" : "LowHistoricVolumeFloor"),
    all_opening_trades: partial.all_opening_trades,
    has_floor: Boolean(partial.has_floor),
    has_multileg: false,
    has_singleleg: true,
    has_sweep: partial.has_sweep,
    issue_type: "Common Stock",
    marketcap: 50_000_000_000,
    open_interest: 4000,
    option_chain: chain(partial.ticker, partial.expiry, partial.type, strikeN),
    total_ask_side_prem: partial.total_ask_side_prem ?? "400000",
    total_bid_side_prem: partial.total_bid_side_prem ?? "30000",
    total_premium: partial.total_premium ?? "450000",
    total_size: 500,
    trade_count: 14,
    volume: 9000,
    volume_oi_ratio: partial.volume_oi_ratio ?? "2.20",
  };
}

function sweepCall(
  id: string,
  ticker: string,
  strike: string,
  expiry: string,
  created: string,
  spot: string | undefined,
  opening: boolean,
): FlowAlert {
  return alert({
    id,
    ticker,
    type: "call",
    strike,
    expiry,
    created_at: created,
    has_sweep: true,
    all_opening_trades: opening,
    underlying_price: spot,
  });
}

function sweepPut(
  id: string,
  ticker: string,
  strike: string,
  expiry: string,
  created: string,
  spot: string | undefined,
): FlowAlert {
  return alert({
    id,
    ticker,
    type: "put",
    strike,
    expiry,
    created_at: created,
    has_sweep: true,
    all_opening_trades: false,
    underlying_price: spot,
  });
}

function agedCallWatch(
  id: string,
  ticker: string,
  strike: string,
  expiry: string,
  spot: string | undefined,
  floor: boolean,
): FlowAlert {
  return alert({
    id,
    ticker,
    type: "call",
    strike,
    expiry,
    created_at: WATCH_SEP3,
    has_sweep: false,
    all_opening_trades: true,
    has_floor: floor,
    underlying_price: spot,
    total_premium: floor ? "900000" : "280000",
    total_ask_side_prem: floor ? "900000" : "250000",
    total_bid_side_prem: "0",
    volume_oi_ratio: floor ? "3.20" : "1.40",
    alert_rule: floor ? "LowHistoricVolumeFloor" : "RepeatedHits",
  });
}

export const BOOK_ASSUMPTIONS = [
  "No UW calls. Premiums, vol/OI, and spots are study fixtures, not Friday Yahoo prints.",
  "Ask-side ~93% on sweep rows (ask-sweep family). Aged call watches are floor/ask-taken leftovers.",
  "Spots only where the prior study already used one (MU 1048, TSLA 348, INTC 97.40, SNDK 1680, MMM 155, YPF 51.71). Others omit spot so moneyness is skipped.",
  "PGEN expiry not in the list — treated as Sep18. MMM Oct16 strike listed as 190C in the chat list.",
  "Tide: aligned when the book said tide aligned or ask-sweep+tide; INTC tide unknown; GH none.",
  "Follow-through: GH = premium still up. Same-day losers = none by close. Morning winners = pending at 10:20, none by 20:00 unless we invent a second print (we do not).",
  "9 unnamed flats from the original 32 are one template row, not invented tickers.",
] as const;

export function sep4Book(): BookRow[] {
  const ypf = ypfAug17FloorAlert();

  const winners: BookRow[] = [
    {
      id: "mu-1060c",
      label: "MU 1060C Sep18",
      outcomePct: 0.7,
      cls: "winner",
      lane: "morning_chat",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "pending",
      notes: "Not all-opening. Fresh ask-sweep + tide.",
      alert: sweepCall("mu-1060c", "MU", "1060", "2026-09-18", MORNING, "1048", false),
    },
    {
      id: "gh-150p",
      label: "GH 150P Sep18",
      outcomePct: 0.54,
      cls: "winner",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: false,
      createdAt: "2026-09-03T11:40:00-04:00",
      armedAt: "2026-09-03T11:40:00-04:00",
      followThrough: "premium",
      notes: "Watch armed ~Sep 3. Premium still up Friday — the one aged watch that worked.",
      alert: alert({
        id: "gh-150p",
        ticker: "GH",
        type: "put",
        strike: "150",
        expiry: "2026-09-18",
        created_at: "2026-09-03T11:40:00-04:00",
        has_sweep: false,
        all_opening_trades: false,
        total_premium: "180000",
        total_ask_side_prem: "160000",
        total_bid_side_prem: "15000",
        volume_oi_ratio: "1.60",
      }),
    },
    {
      id: "tsla-350p",
      label: "TSLA 350P Sep11",
      outcomePct: 0.48,
      cls: "winner",
      lane: "morning",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "pending",
      notes: "Clean ask sweep, nearer-the-money than 360P.",
      alert: sweepPut("tsla-350p", "TSLA", "350", "2026-09-11", MORNING, "348"),
    },
    {
      id: "intc-99c",
      label: "INTC 99C Sep18",
      outcomePct: 0.4,
      cls: "winner",
      lane: "morning_chat",
      sweep: true,
      tide: "unknown",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "pending",
      notes: "Not all-opening. Tide not tagged in the book.",
      alert: sweepCall("intc-99c", "INTC", "99", "2026-09-18", MORNING, "97.40", false),
    },
  ];

  const losers: BookRow[] = [
    {
      id: "mmm-190c-sep18",
      label: "MMM 190C Sep18",
      outcomePct: -0.98,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: WATCH_SEP3,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Aged call watch. Worst class.",
      alert: agedCallWatch("mmm-190c-sep18", "MMM", "190", "2026-09-18", "155", true),
    },
    {
      id: "mmm-190c-oct16",
      label: "MMM 190C Oct16",
      outcomePct: -0.86,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: WATCH_SEP3,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Aged call watch, longer-dated.",
      alert: agedCallWatch("mmm-190c-oct16", "MMM", "190", "2026-10-16", "155", true),
    },
    {
      id: "pgen-8c",
      label: "PGEN 8C Sep18",
      outcomePct: -0.8,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: WATCH_SEP3,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Expiry not in the list — Sep18 fixture. Aged call watch.",
      alert: agedCallWatch("pgen-8c", "PGEN", "8", "2026-09-18", undefined, false),
    },
    {
      id: "avgo-387c",
      label: "AVGO 387.5C",
      outcomePct: -0.72,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: WATCH_SEP3,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Aged call watch. Expiry not listed — Sep18 fixture.",
      alert: agedCallWatch("avgo-387c", "AVGO", "387.5", "2026-09-18", undefined, false),
    },
    {
      id: "trmb-60c",
      label: "TRMB 60C",
      outcomePct: -0.49,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: WATCH_SEP3,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Aged call watch. Expiry not listed — Sep18 fixture.",
      alert: agedCallWatch("trmb-60c", "TRMB", "60", "2026-09-18", undefined, false),
    },
    {
      id: "ypf-55c",
      label: "YPF 55C",
      outcomePct: -0.18,
      cls: "loser",
      lane: "watch",
      sweep: false,
      tide: "none",
      allOpening: true,
      createdAt: ypf.created_at,
      armedAt: WATCH_SEP3,
      followThrough: "none",
      notes: "Aug 17 floor still armed into Sep 4. Stale whale.",
      alert: ypf,
    },
    {
      id: "sndk-1700p",
      label: "SNDK 1700P",
      outcomePct: -0.27,
      cls: "loser",
      lane: "picks",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Ask-sweep + tide on Picks. No later confirm in the book.",
      alert: sweepPut("sndk-1700p", "SNDK", "1700", "2026-09-18", MORNING, "1680"),
    },
    {
      id: "mu-950p",
      label: "MU 950P",
      outcomePct: -0.26,
      cls: "loser",
      lane: "morning",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Same-morning ask-sweep + tide that still lost.",
      alert: sweepPut("mu-950p", "MU", "950", "2026-09-18", MORNING, "1048"),
    },
    {
      id: "tsla-360p-sep9",
      label: "TSLA 360P Sep9",
      outcomePct: -0.18,
      cls: "loser",
      lane: "picks",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Further ITM + 5 DTE vs 350P Sep11.",
      alert: sweepPut("tsla-360p-sep9", "TSLA", "360", "2026-09-09", MORNING, "348"),
    },
    {
      id: "len-81p",
      label: "LEN 81P",
      outcomePct: -0.17,
      cls: "loser",
      lane: "picks",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Ask-sweep + tide on Picks. Spot omitted.",
      alert: sweepPut("len-81p", "LEN", "81", "2026-09-18", MORNING, undefined),
    },
    {
      id: "nvda-235c",
      label: "NVDA 235C",
      outcomePct: -0.17,
      cls: "loser",
      lane: "morning_chat",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Morning chat, ask-sweep + tide, still lost.",
      alert: sweepCall("nvda-235c", "NVDA", "235", "2026-09-18", MORNING, undefined, false),
    },
    {
      id: "tsla-360p-sep11",
      label: "TSLA 360P Sep11",
      outcomePct: -0.16,
      cls: "loser",
      lane: "picks",
      sweep: true,
      tide: "aligned",
      allOpening: false,
      createdAt: MORNING,
      followThrough: "none",
      notes: "Same tags as 350P; further ITM.",
      alert: sweepPut("tsla-360p-sep11", "TSLA", "360", "2026-09-11", MORNING, "348"),
    },
  ];

  const namedFlats: Array<[string, string, string]> = [
    ["qqq-put", "QQQ", "480"],
    ["smh-put", "SMH", "280"],
    ["amzn-put", "AMZN", "220"],
    ["hd-put", "HD", "360"],
    ["mdb-put", "MDB", "320"],
    ["nvda-230p", "NVDA", "230"],
  ];

  const flats: BookRow[] = namedFlats.map(([id, ticker, strike]) => ({
    id,
    label: `${ticker} ${strike}P Sep18`,
    outcomePct: 0,
    cls: "flat" as const,
    lane: "flat" as const,
    sweep: true,
    tide: "aligned" as const,
    allOpening: false,
    createdAt: MORNING,
    followThrough: "none" as const,
    notes: "Named flat ask-sweep + tide put from the lessons file.",
    alert: sweepPut(id, ticker, strike, "2026-09-18", MORNING, undefined),
  }));

  const template: BookRow = {
    id: "flat-template",
    label: "Unnamed ask-sweep+tide puts (×9)",
    outcomePct: 0,
    cls: "flat",
    lane: "flat",
    sweep: true,
    tide: "aligned",
    allOpening: false,
    createdAt: MORNING,
    followThrough: "none",
    notes: "The original 32 had ~9 more flats without ticker/strike. Same tag family as the named flats — not invented names.",
    alert: sweepPut("flat-template", "FLAT", "100", "2026-09-18", MORNING, undefined),
  };

  const noQuote: BookRow = {
    id: "no-quote",
    label: "Unnamed (no Yahoo quote)",
    outcomePct: null,
    cls: "no_quote",
    lane: "flat",
    sweep: false,
    tide: "unknown",
    allOpening: false,
    createdAt: CLOSE,
    followThrough: "none",
    notes: "Lessons: 1 of 32 had no quote. Cannot score outcome.",
    alert: alert({
      id: "no-quote",
      ticker: "UNKN",
      type: "call",
      strike: "0",
      expiry: "2026-09-18",
      created_at: CLOSE,
      has_sweep: false,
      all_opening_trades: false,
      total_premium: "0",
    }),
  };

  return [...winners, ...losers, ...flats, template, noQuote];
}

export const SCORE_AT = {
  morning: new Date("2026-09-04T10:55:00-04:00"),
  close: new Date("2026-09-04T20:00:00-04:00"),
};
