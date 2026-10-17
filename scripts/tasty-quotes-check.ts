/** Checks for the TEST-mode Tastytrade quote comparison core (pure logic). Run: npx tsx scripts/tasty-quotes-check.ts */
import assert from "node:assert/strict";

import { compareRow, fromTastyOcc, parseTastyItem, summarize, toTastyOcc } from "@/lib/tasty-core";

// Symbol conversion: UW/FlowGuard OCC <-> Tastytrade OCC (root padded to 6).
assert.equal(toTastyOcc("NFLX261023C00070000"), "NFLX  261023C00070000");
assert.equal(toTastyOcc("spy261120p00452500"), "SPY   261120P00452500");
assert.equal(toTastyOcc("SPXW261120C05000000"), "SPXW  261120C05000000");
assert.equal(toTastyOcc("AAPL1261120C00150000"), "AAPL1 261120C00150000");
assert.equal(toTastyOcc("garbage"), null);
assert.equal(toTastyOcc(""), null);
assert.equal(fromTastyOcc("SPY   261120P00452500"), "SPY261120P00452500");

// REST item parsing (decimal strings, dasherized keys); mid computed when absent.
const q = parseTastyItem({ symbol: "SPY   261120P00452500", bid: "1.10", ask: "1.20", mark: "1.15", "updated-at": "2026-10-19T14:00:00Z" });
assert.deepEqual(q, { bid: 1.1, ask: 1.2, mid: 1.15, mark: 1.15, last: null, updatedAt: "2026-10-19T14:00:00Z" });

const base = { at: "2026-10-19T14:00:00Z", contract: "SPY261120P00452500", ticker: "SPY", from: "spread-check", refSource: "spread_memo" as const, refAt: null };
// UW 1.00/1.08 (7.7%, ok) vs Tasty 1.00/1.20 (18%, wide) -> gate would disagree (study only).
const r = compareRow({ ...base, ref: { bid: 1.0, ask: 1.08 }, tasty: { ...q, bid: 1.0, ask: 1.2, mid: 1.1 } }, 0.1);
assert.equal(r.refSpreadPct, 0.0769);
assert.equal(r.tastySpreadPct, 0.1818);
assert.equal(r.bidDiff, 0);
assert.equal(r.askDiff, 0.12);
assert.equal(r.gateDisagrees, true);
// Missing Tastytrade quote -> nulls, never throws.
const miss = compareRow({ ...base, ref: { bid: 1, ask: 1.05 }, tasty: null }, 0.1);
assert.equal(miss.bidDiff, null);
assert.equal(miss.gateDisagrees, null);

const s = summarize([r, miss]);
assert.equal(s.rows, 2);
assert.equal(s.withBoth, 1);
assert.equal(s.tastyMissing, 1);
assert.equal(s.avgAbsAskDiff, 0.12);
assert.equal(s.gateDisagreements, 1);

console.log("tasty-quotes-check OK");
