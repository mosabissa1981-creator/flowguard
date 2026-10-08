/**
 * LIVE risk-off flag checks (approved 10/8/2026).
 * Run: npx tsx --conditions=react-server scripts/risk-off-check.ts
 */
import assert from "node:assert/strict";

import {
  RISK_OFF_BANNER,
  RISK_OFF_BLOCK_ETF_PUTS,
  RISK_OFF_PUT_REASON,
  blockedByRiskOffPuts,
  evaluateRiskOff,
} from "@/lib/risk-off";
import { resolveSpread, splitByLiveRules } from "@/lib/spread-core";

assert.equal(RISK_OFF_BLOCK_ETF_PUTS, true);
assert.match(RISK_OFF_BANNER, /Risk-off morning/);
assert.equal(RISK_OFF_PUT_REASON, "Skipped: risk-off morning (ETF puts held back)");

// Oct 8 2026-style inputs: oil gap +3.07%, QQQ gap -0.5% → PRIMARY (2 signals).
const oct8 = evaluateRiskOff(
  {
    usoYdayPct: -0.69,
    usoGapPct: 3.07,
    tnxYdayBp: 0.8,
    tltYdayPct: -0.17,
    tltGapPct: 0.05,
    qqqGapPct: -0.5,
    spyGapPct: -0.3,
    qqqVsSpyGapPct: -0.2,
  },
  { day: "2026-10-08", provisional: false },
);
assert.equal(oct8.level, "primary");
assert.equal(oct8.oil, true);
assert.equal(oct8.qqqWeak, true);
assert.equal(oct8.yield, false);
assert.equal(oct8.nSignals, 2);
assert.equal(oct8.blockEtfPuts, true);
assert.equal(oct8.banner, RISK_OFF_BANNER);

// Soft: oil only.
const soft = evaluateRiskOff(
  { usoYdayPct: 2.5, usoGapPct: null, tnxYdayBp: 0, tltYdayPct: 0, tltGapPct: 0, qqqGapPct: 0.1, spyGapPct: 0, qqqVsSpyGapPct: 0.1 },
  { day: "2026-01-01", provisional: false },
);
assert.equal(soft.level, "soft");
assert.equal(soft.blockEtfPuts, false);

// None.
const none = evaluateRiskOff(
  { usoYdayPct: 0, usoGapPct: 0, tnxYdayBp: 0, tltYdayPct: 0, tltGapPct: 0, qqqGapPct: 0, spyGapPct: 0, qqqVsSpyGapPct: 0 },
  { day: "2026-01-02", provisional: false },
);
assert.equal(none.level, "none");
assert.equal(none.blockEtfPuts, false);

// Unknown: all null → never blocks.
const unk = evaluateRiskOff(
  { usoYdayPct: null, usoGapPct: null, tnxYdayBp: null, tltYdayPct: null, tltGapPct: null, qqqGapPct: null, spyGapPct: null, qqqVsSpyGapPct: null },
  { day: "2026-01-03", provisional: true },
);
assert.equal(unk.level, "unknown");
assert.equal(unk.blockEtfPuts, false);

// Block helper: ETF put blocked on primary; call not; single-stock put not (other rule).
assert.equal(blockedByRiskOffPuts("put", "QQQ", "ETF", oct8), true);
assert.equal(blockedByRiskOffPuts("call", "QQQ", "ETF", oct8), false);
assert.equal(blockedByRiskOffPuts("put", "AAPL", "Common Stock", oct8), false);
assert.equal(blockedByRiskOffPuts("put", "QQQ", "ETF", soft), false);

// Gate: ETF put skipped with risk-off reason; call kept.
const AT = "2026-10-08T15:00:00.000Z";
const rows = [
  { id: "QQQ261030P00700000", ticker: "QQQ", side: "put", issueType: "ETF", bid: 1.0, ask: 1.05 },
  { id: "AAPL261030C00200000", ticker: "AAPL", side: "call", issueType: "Common Stock", bid: 2.0, ask: 2.1 },
];
const { kept, skipped } = splitByLiveRules(
  rows,
  (r) => resolveSpread(null, { bid: r.bid, ask: r.ask }, AT),
  (r) => ({ option_chain: r.id, ticker: r.ticker }),
  (r) => ({ side: r.side, ticker: r.ticker, issueType: r.issueType }),
  "picks",
  oct8,
);
assert.equal(kept.length, 1);
assert.equal(kept[0].ticker, "AAPL");
assert.equal(skipped.length, 1);
assert.equal(skipped[0].rule, "risk-off");
assert.equal(skipped[0].reason, RISK_OFF_PUT_REASON);

console.log("risk-off-check: all assertions passed");
