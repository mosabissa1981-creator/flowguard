#!/usr/bin/env node
/**
 * Build study/study-summary.json from the desk study books (book-YYYY-MM-DD.json).
 * Usage: node scripts/build-study-summary.mjs [studyDir] [--since 2026-09-23] [--recent 40]
 * The AI-picks prompt reads this file (and /api/study-summary serves it).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const studyDir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--")) || "study";
const since = flag("--since", "2026-09-24");
const recentN = Number(flag("--recent", "40"));
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "study", "study-summary.json");

const files = fs
  .readdirSync(studyDir)
  .filter((f) => /^book-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

const blank = () => ({ w: 0, l: 0, flat: 0 });
const add = (b, o) => {
  if (o === "winner") b.w += 1;
  else if (o === "loser") b.l += 1;
  else if (o === "expired_flat") b.flat += 1;
};

const rows = [];
for (const f of files) {
  const day = f.slice(5, 15);
  if (day < since) continue;
  const book = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  for (const r of book.rows || []) {
    const outcome = r.outcome || r.status;
    if (!["winner", "loser", "expired_flat"].includes(outcome)) continue;
    const src = String(r.source || r.row_origin || "");
    const late = /late/i.test(src) || (r.why_tags || []).includes("late print");
    const morning = /morning/i.test(src) && !late;
    const chipIds = (r.chips || []).map((c) => c.id);
    rows.push({
      day,
      contract: r.option_chain || r.id,
      ticker: r.ticker,
      type: r.type,
      dte: r.dte ?? null,
      score: r.score ?? r.conviction ?? null,
      lane: r.lane || (/picks\+premove/.test(src) ? "BOTH" : /premove/.test(src) ? "Premove-only" : /picks/.test(src) ? "Picks-only" : null),
      bucket: morning ? "morning" : late ? "late" : "other",
      outcome,
      pct: typeof r.outcome_pct === "number" ? r.outcome_pct : null,
      entry: r.entry_ref ?? r.alert_price ?? null,
      tags: [...new Set(r.why_tags || [])].filter((t) => !/^morning shortlist|scrolled off/.test(t)).slice(0, 10),
      quiet: chipIds.includes("quiet") || (r.why_tags || []).includes("quiet underlying"),
    });
  }
}

const totals = blank();
const byBucket = { morning: blank(), late: blank(), other: blank() };
const bothScore100 = blank();
const quiet = blank();
const dteSweet = blank();
const bySide = { call: blank(), put: blank() };
const byIssuerDay = new Map();
for (const r of rows) {
  add(totals, r.outcome);
  add(byBucket[r.bucket], r.outcome);
  if (r.lane === "BOTH" && r.score === 100) add(bothScore100, r.outcome);
  if (r.quiet) add(quiet, r.outcome);
  if (r.dte != null && r.dte >= 11 && r.dte <= 30) add(dteSweet, r.outcome);
  if (bySide[r.type]) add(bySide[r.type], r.outcome);
  const issuer = r.ticker === "GOOG" ? "GOOGL" : r.ticker;
  const k = `${r.day}|${issuer}`;
  const cur = byIssuerDay.get(k) || { day: r.day, issuer, n: 0, losers: 0, winners: 0 };
  cur.n += 1;
  if (r.outcome === "loser") cur.losers += 1;
  if (r.outcome === "winner") cur.winners += 1;
  byIssuerDay.set(k, cur);
}
const clusters = [...byIssuerDay.values()].filter((c) => c.n >= 2 && c.losers >= 2);

const decided = rows.filter((r) => r.outcome !== "expired_flat");
const recent = decided.slice(-recentN);

const summary = {
  generatedAt: new Date().toISOString(),
  since,
  through: rows.length ? rows[rows.length - 1].day : null,
  days: [...new Set(rows.map((r) => r.day))].length,
  definition: "winner ≥ +15% option premium by EOD check, loser ≤ −15%, else expired_flat. Entry = flow print.",
  totals,
  buckets: {
    morning: byBucket.morning,
    late: byBucket.late,
    other: byBucket.other,
    bothLaneScore100: bothScore100,
    quietUnderlying: quiet,
    dte11to30: dteSweet,
    calls: bySide.call,
    puts: bySide.put,
  },
  correlatedLossClusters: clusters,
  lessons: [
    "All decided trades came from the morning shortlist; late prints (≥14:00 ET) were all flat.",
    "Both-lane score-100 is not an edge (ties at the clamp); do not treat overlap as confirmation.",
    "Same-issuer clusters (GOOG/GOOGL 9/30, APP 9/24) lose together — one bet, not several.",
    "Quiet underlying + morning ask-side in 11–30 DTE produced the cleanest winners (INTC 130C +33%, META 800C +42%).",
    "Rising long yields into reports hurt long-duration tech calls.",
  ],
  recentDecided: recent,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(`wrote ${out}: ${rows.length} rows, ${decided.length} decided, ${clusters.length} clusters`);
