/** Checks for the LIVE spread gate core (pure logic). Run: npm run spread-gate-check */
import assert from "node:assert/strict";

import { SPREAD_MAX_PCT, resolveSpread, splitBySpread, spreadFromPair, spreadSkipReason } from "@/lib/spread-core";

const AT = "2026-10-08T14:00:00.000Z";

// One threshold, 10% of mid.
assert.equal(SPREAD_MAX_PCT, 0.1);

// Pair math: 1.00 / 1.10 → mid 1.05, spread 9.52% → ok.
assert.deepEqual(spreadFromPair(1, 1.1), { bid: 1, ask: 1.1, mid: 1.05, pct: 0.0952 });
// String inputs (flow alerts send strings).
assert.equal(spreadFromPair("2.00", "2.50")?.pct, 0.2222);
// No bid at all (0) with an ask → 200% spread.
assert.equal(spreadFromPair(0, 0.5)?.pct, 2);
// Unusable pairs.
assert.equal(spreadFromPair(null, 1), null);
assert.equal(spreadFromPair(1.2, 1.0), null); // crossed
assert.equal(spreadFromPair(0, 0), null);
assert.equal(spreadFromPair("", "1"), null);

// Fresh UW NBBO wins over the alert's bid/ask.
const fresh = resolveSpread({ bid: 1.0, ask: 1.08 }, { bid: "0.50", ask: "1.50" }, AT);
assert.equal(fresh.source, "uw_nbbo");
assert.equal(fresh.status, "ok");
assert.equal(fresh.pct, 0.0769);

// Fresh one-sided → falls back to the alert pair.
const fb = resolveSpread({ bid: null, ask: 1.1 }, { bid: "1.00", ask: "1.30" }, AT);
assert.equal(fb.source, "alert");
assert.equal(fb.status, "wide");
assert.equal(fb.pct, 0.2609);
assert.equal(spreadSkipReason(fb), "Skipped: wide spread 26%");

// Neither usable → "unknown" (kept, tagged), one-sided numbers preserved for the study.
const unk = resolveSpread(null, { bid: "", ask: "0.90" }, AT);
assert.equal(unk.status, "unknown");
assert.equal(unk.source, "none");
assert.equal(unk.pct, null);
assert.equal(unk.ask, 0.9);
assert.equal(resolveSpread(undefined, undefined, AT).status, "unknown");

// Boundary: exactly 10% is allowed; just over is wide.
assert.equal(resolveSpread({ bid: 0.95, ask: 1.05 }, null, AT).status, "ok"); // 10.0%
assert.equal(resolveSpread({ bid: 0.949, ask: 1.051 }, null, AT).status, "wide"); // 10.2%

// Split: wide rows skipped with a reason, ok + unknown kept (annotated), order preserved.
const rows = [
  { id: "A", bid: 1.0, ask: 1.05 },
  { id: "B", bid: 1.0, ask: 1.5 },
  { id: "C", bid: null, ask: null },
  { id: "D", bid: 2.0, ask: 2.1 },
];
const { kept, skipped } = splitBySpread(
  rows,
  (r) => resolveSpread(null, { bid: r.bid, ask: r.ask }, AT),
  (r) => ({ option_chain: r.id, ticker: "T" }),
  "picks",
);
assert.deepEqual(kept.map((r) => r.id), ["A", "C", "D"]);
assert.equal(kept[1].spread.status, "unknown");
assert.equal(skipped.length, 1);
assert.equal(skipped[0].option_chain, "B");
assert.equal(skipped[0].reason, "Skipped: wide spread 40%");
assert.equal(skipped[0].list, "picks");

console.log("spread-gate-check: all assertions passed");
