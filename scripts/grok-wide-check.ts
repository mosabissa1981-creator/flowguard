/**
 * Checks for the TEST-mode Grok wide pool (lib/shadow/wide-pool-core.ts): selection rules on a cached history day and
 * grading against the live exit rules. Cached files only (no UW, no LLM). Usage: npx tsx scripts/grok-wide-check.ts [day]
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { issuerKey } from "../lib/issuers";
import { rankAlerts } from "../lib/scoring";
import { SPREAD_MAX_PCT } from "../lib/spread-core";
import type { FlowAlert } from "../lib/types";
import { WIDE_MAX_PER_ISSUER, gradeWide, selectWide, wideFactLine } from "../lib/shadow/wide-pool-core";

// 1) grading (entry 1.00, spread 0 → exits at the level itself)
const c = { entry: 1, spreadPct: 0 };
const bar = (date: string, open: number, high: number, low: number, close: number) => ({ date, open, high, low, close });
assert.equal(gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-01", 1, 2, 0.5, 1)]).status, "pending", "entry-day bar is ignored");
assert.equal(gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-02", 0.7, 0.8, 0.6, 0.7)]).how, "stop_gap");
assert.equal(gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-02", 1.4, 1.5, 1.3, 1.4)]).how, "target_gap");
const both = gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-02", 1, 1.4, 0.7, 1.1)]);
assert.equal(both.how, "stop", "stop before target inside one session (conservative)");
assert.ok(Math.abs((both.ret ?? 0) + 0.25) < 1e-9);
const tgt = gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-02", 1, 1.35, 0.9, 1.2)]);
assert.equal(tgt.how, "target");
assert.ok(Math.abs((tgt.ret ?? 0) - 0.3) < 1e-9);
const time = gradeWide({ entry: 1, spreadPct: 0.1 }, "2026-10-01", "2026-10-05", [bar("2026-10-02", 1, 1.1, 0.9, 1.05), bar("2026-10-05", 1.05, 1.1, 0.95, 1.1)]);
assert.equal(time.how, "time");
assert.ok(Math.abs((time.ret ?? 0) - (1.1 * 0.95 - 1)) < 1e-9, "sell at close × (1 − spread/2)");
assert.equal(gradeWide(c, "2026-10-01", "2026-10-05", [bar("2026-10-02", 1, 1.1, 0.9, 1.05)]).status, "pending", "no time-stop bar yet");
console.log("grading: ok");

// 2) selection on a cached history day
const H = process.env.HISTORY_DIR ?? "/workspace/flowguard/history";
const day = process.argv[2] ?? "2026-10-15";
const f = `${H}/flow/${day}.json.gz`;
if (!existsSync(f)) {
  console.log(`selection: skipped (no ${f})`);
  process.exit(0);
}
const j = JSON.parse(gunzipSync(readFileSync(f)).toString());
const all: FlowAlert[] = j.rows.map((r: unknown[]) => Object.fromEntries(j.fields.map((k: string, i: number) => [k, r[i]])) as unknown as FlowAlert);
const total: Record<string, number> = {};
const seen = new Set<string>();
const counts: Record<string, number> = {};
for (const hhmm of ["10:00", "11:00", "12:00", "13:00", "14:00"]) {
  const now = new Date(`${day}T${hhmm}:00-04:00`);
  const tape = all.filter((a) => Date.parse(a.created_at) <= now.getTime());
  const pick = selectWide(rankAlerts(tape, { now }), { now, exclude: seen, limit: 40, issuerCounts: counts });
  for (const p of pick) {
    assert.ok(!seen.has(p.contract), "no repeats across runs");
    assert.ok(p.spreadPct <= SPREAD_MAX_PCT, "spread gate");
    assert.ok(p.score >= 45 && p.dte >= 0 && p.dte <= 60 && p.premiumUsd >= 10_000);
    seen.add(p.contract);
    counts[issuerKey(p.ticker)] = (counts[issuerKey(p.ticker)] ?? 0) + 1;
    total[p.tier] = (total[p.tier] ?? 0) + 1;
  }
  const near = pick.filter((p) => p.tier === "near-miss").length;
  assert.ok(near <= Math.floor(40 / 3), "near-miss share ≤ 1/3 of a run");
  console.log(`${day} ${hhmm} ET: ${pick.length} new (${near} near-miss)`);
}
for (const [iss, n] of Object.entries(counts)) assert.ok(n <= WIDE_MAX_PER_ISSUER, `issuer cap ${iss}`);
const sample = [...seen][0];
console.log(`selection: ok — ${seen.size} candidates over 5 runs, ${Object.keys(counts).length} issuers, tiers ${JSON.stringify(total)}`);
if (sample) console.log("fact line sample:", wideFactLine(selectWide(rankAlerts(all.filter((a) => Date.parse(a.created_at) <= Date.parse(`${day}T11:00:00-04:00`)), { now: new Date(`${day}T11:00:00-04:00`) }), { now: new Date(`${day}T11:00:00-04:00`), exclude: new Set(), limit: 1 })[0]));
