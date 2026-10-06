/** Sanity checks for the paper-account core (pure logic). Run: npm run paper-check */
import assert from "node:assert/strict";

import {
  SIZING,
  bookStats,
  closePosition,
  entryFill,
  exitDecision,
  exitValue,
  levelsFor,
  newBalanceDoc,
  parseOcc,
  sizeTrade,
  spreadNet,
  type PaperPosition,
} from "@/lib/paper-core";

// Sizing: $10k, 2% = $200 → $1.83 ask = 1 contract ($183); $0.50 → 4 contracts; $6 → skip (> 5%).
assert.deepEqual(sizeTrade(1.83, 10_000, 0, SIZING.main), { ok: true, qty: 1, costUsd: 183 });
assert.deepEqual(sizeTrade(0.5, 10_000, 0, SIZING.main), { ok: true, qty: 4, costUsd: 200 });
assert.equal(sizeTrade(6, 10_000, 0, SIZING.main).ok, false);
// $4.80 → 1 contract ($480) allowed (≤ 5%).
assert.deepEqual(sizeTrade(4.8, 10_000, 0, SIZING.main), { ok: true, qty: 1, costUsd: 480 });
// Open-risk cap 10% ($1,000): $900 open + $183 → skip; $700 open + 4×$50 → fits.
assert.equal(sizeTrade(1.83, 10_000, 900, SIZING.main).ok, false);
assert.deepEqual(sizeTrade(0.5, 10_000, 700, SIZING.main), { ok: true, qty: 4, costUsd: 200 });
assert.deepEqual(sizeTrade(0.5, 10_000, 850, SIZING.main), { ok: true, qty: 3, costUsd: 150 });

// Fills.
assert.deepEqual(entryFill({ bid: 1.7, ask: 1.9, last: 1.8, asOf: null }, 1.83), { price: 1.9, basis: "uw_ask" });
assert.deepEqual(entryFill(null, 1.83), { price: 1.92, basis: "alert+5%" });
assert.deepEqual(exitValue({ bid: 2.4, ask: 2.5, last: 2.45, asOf: null }), { value: 2.4, basis: "uw_bid" });
assert.deepEqual(exitValue({ bid: null, ask: null, last: 2, asOf: null }), { value: 1.9, basis: "last-5%" });

// Spread (calendar: sell near, buy far).
const legs = [
  { option_chain: "LW261016C00045000", ticker: "LW", action: "sell" as const },
  { option_chain: "LW261120C00045000", ticker: "LW", action: "buy" as const },
];
const q = {
  LW261016C00045000: { bid: 1.85, ask: 1.95, last: 1.9, asOf: null },
  LW261120C00045000: { bid: 2.25, ask: 2.55, last: 2.4, asOf: null },
};
assert.equal(spreadNet(legs, q, "entry"), 0.7); // 2.55 − 1.85
assert.equal(spreadNet(legs, q, "exit"), 0.3); // 2.25 − 1.95

// Exits.
const lv = levelsFor(1.9, 30, -25);
assert.deepEqual(lv, { target: 2.47, stop: 1.42 });
const pos: PaperPosition = {
  id: "main:2026-10-06:NFLX261023C00070000", book: "main", source: "ai-pick", day: "2026-10-06",
  contract: "NFLX261023C00070000", ticker: "NFLX", side: "call", strike: 70, expiry: "2026-10-23", qty: 1,
  entryPrice: 1.9, entryBasis: "uw_ask", alertPrice: 1.83, enteredAt: "2026-10-06T15:00:00Z", costUsd: 190,
  targetPct: 30, stopPct: -25, target: lv.target, stop: lv.stop, timeStopDate: "2026-10-09",
};
const now = new Date("2026-10-07T15:00:00Z");
assert.equal(exitDecision(pos, { value: 2.5 }, now, "2026-10-07", 11 * 60), "target");
assert.equal(exitDecision(pos, { value: 1.4 }, now, "2026-10-07", 11 * 60), "stop");
assert.equal(exitDecision(pos, { value: 2 }, now, "2026-10-07", 11 * 60), null);
assert.equal(exitDecision(pos, { value: 2 }, now, "2026-10-09", 15 * 60 + 29), null);
assert.equal(exitDecision(pos, { value: 2 }, now, "2026-10-09", 15 * 60 + 30), "time");
assert.equal(exitDecision(pos, null, now, "2026-10-10", 10 * 60), "time");
assert.equal(exitDecision({ ...pos, timeStopDate: "2026-10-30" }, { value: 2 }, now, "2026-10-23", 15 * 60 + 45), "expiry");

const closed = closePosition(pos, 2.5, "uw_bid", "target", now);
assert.equal(closed.pnlUsd, 60);
assert.equal(closed.pnlPct, 31.58);

// Stats.
const doc = newBalanceDoc(new Date("2026-10-05T00:00:00Z"));
const bal = { ...doc.books.main, balance: 10_000 - 190 + 250, realizedUsd: 60 };
const st = bookStats("main", bal, [], [closed], 10_000);
assert.equal(st.equity, 10_060);
assert.equal(st.pnlTotalUsd, 60);
assert.equal(st.pnlTodayUsd, 60);
assert.equal(st.winRatePct, 100);

// Equity values open positions at the last bid (cost when unmarked).
const openBal = { ...doc.books.main, balance: 10_000 - 190, realizedUsd: 0 };
assert.equal(bookStats("main", openBal, [pos], []).equity, 10_000);
const marked = { ...pos, lastMark: { value: 2.2, basis: "uw_bid", bid: 2.2, ask: 2.3, last: 2.25, at: "", quoteAsOf: null } };
const st2 = bookStats("main", openBal, [marked], [], 10_000);
assert.equal(st2.equity, 10_030);
assert.equal(st2.unrealizedUsd, 30);
assert.equal(st2.pnlTodayUsd, 30);

// OCC parsing.
assert.deepEqual(parseOcc("NFLX261023C00070000"), { ticker: "NFLX", expiry: "2026-10-23", side: "call", strike: 70 });
assert.deepEqual(parseOcc("SPY261014C00786000"), { ticker: "SPY", expiry: "2026-10-14", side: "call", strike: 786 });
assert.deepEqual(parseOcc("TRMD261016C00042500")?.strike, 42.5);
assert.equal(parseOcc("NFLX"), null);

console.log("paper-check: all assertions passed");
