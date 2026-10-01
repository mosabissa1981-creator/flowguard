#!/usr/bin/env node
/**
 * Build study/study-summary.json from the desk study books (book-YYYY-MM-DD.json).
 * Usage: node scripts/build-study-summary.mjs [studyDir] [--since 2026-09-23] [--recent 40]
 * The AI-picks prompt reads this file (and /api/study-summary serves it).
 * Also: shadowAccuracy (from study/shadow-*.json), study/regime-days.json, study/candidate-history.json.
 * `--yields` refreshes study/treasury-yields.json from the Treasury par-yield CSV (otherwise the cached file is used).
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

// ---------------------------------------------------------------------------
// Shadow-module accuracy (study/shadow-YYYY-MM-DD.json saved by the study routine from /api/shadow).
// For each module: outcome mix of flagged vs passed vs boosted candidates, joined to the book by option_chain.
// ---------------------------------------------------------------------------
const outcomeByDayContract = new Map();
for (const f of files) {
  const day = f.slice(5, 15);
  const book = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  for (const r of book.rows || []) {
    const outcome = r.outcome || r.status;
    if (!["winner", "loser", "expired_flat"].includes(outcome)) continue;
    outcomeByDayContract.set(`${day}|${r.option_chain || r.id}`, { outcome, pct: typeof r.outcome_pct === "number" ? r.outcome_pct : null });
  }
}
const shadowFiles = fs.readdirSync(studyDir).filter((f) => /^shadow-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const moduleStats = {};
let shadowJoined = 0;
let shadowUnmatched = 0;
const shadowDays = [];
for (const f of shadowFiles) {
  const day = f.slice(7, 17);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  } catch {
    continue;
  }
  shadowDays.push(day);
  for (const [contract, verdicts] of Object.entries(doc.verdicts || {})) {
    const hit = outcomeByDayContract.get(`${day}|${contract}`);
    if (!hit) {
      shadowUnmatched += 1;
      continue;
    }
    shadowJoined += 1;
    for (const v of verdicts || []) {
      const m = (moduleStats[v.module] ||= { pass: blank(), flag: blank(), boost: blank(), skip: blank(), pctSum: { pass: 0, flag: 0, boost: 0, skip: 0 }, pctN: { pass: 0, flag: 0, boost: 0, skip: 0 } });
      if (!m[v.verdict]) continue;
      add(m[v.verdict], hit.outcome);
      if (hit.pct != null) {
        m.pctSum[v.verdict] += hit.pct;
        m.pctN[v.verdict] += 1;
      }
    }
  }
}
const rate = (b) => {
  const n = b.w + b.l + b.flat;
  return n ? { n, winRate: Math.round((b.w / n) * 1000) / 10, lossRate: Math.round((b.l / n) * 1000) / 10, flatRate: Math.round((b.flat / n) * 1000) / 10 } : { n: 0, winRate: null, lossRate: null, flatRate: null };
};
const shadowAccuracy = {
  days: shadowDays,
  joinedCandidates: shadowJoined,
  unmatchedCandidates: shadowUnmatched,
  definition: "Per module: outcome mix (winner/loser/flat per the book definition) of candidates the module flagged vs passed vs boosted. A useful flag has a lower win rate / higher loss rate than pass; a useful boost has a higher win rate.",
  modules: Object.fromEntries(
    Object.entries(moduleStats).map(([mod, m]) => {
      const out = {};
      for (const k of ["boost", "pass", "flag", "skip"]) {
        out[k] = { ...m[k], ...rate(m[k]), avgPct: m.pctN[k] ? Math.round((m.pctSum[k] / m.pctN[k]) * 10) / 10 : null };
      }
      const nonFlag = { w: m.pass.w + m.boost.w, l: m.pass.l + m.boost.l, flat: m.pass.flat + m.boost.flat };
      const rf = rate(m.flag);
      const rn = rate(nonFlag);
      out.flagEdge = rf.n && rn.n ? { flaggedLossRate: rf.lossRate, othersLossRate: rn.lossRate, flaggedWinRate: rf.winRate, othersWinRate: rn.winRate } : null;
      const rb = rate(m.boost);
      const rp = rate(m.pass);
      out.boostEdge = rb.n && rp.n ? { boostedWinRate: rb.winRate, passedWinRate: rp.winRate } : null;
      return [mod, out];
    }),
  ),
};
summary.shadowAccuracy = shadowAccuracy;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(`wrote ${out}: ${rows.length} rows, ${decided.length} decided, ${clusters.length} clusters`);
console.log(`shadow accuracy: ${shadowDays.length} shadow day(s), ${shadowJoined} candidates joined to book outcomes, ${shadowUnmatched} unmatched`);

// ---------------------------------------------------------------------------
// Regime analog table (study/regime-days.json) + compact candidate history (study/candidate-history.json).
// Both are imported by the app (shadow regime_analogs / same_buyer_tracking) — zero runtime UW calls.
// ---------------------------------------------------------------------------
const outDir = path.dirname(out);
const yieldsCache = path.join(outDir, "treasury-yields.json");
let yields = {};
if (fs.existsSync(yieldsCache)) yields = JSON.parse(fs.readFileSync(yieldsCache, "utf8"));
if (args.includes("--yields")) {
  const years = [...new Set(files.map((f) => f.slice(5, 9)))];
  for (const y of years) {
    try {
      const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
      const res = await fetch(url, { headers: { "User-Agent": "FlowGuard study builder" } });
      const text = await res.text();
      const lines = text.trim().split(/\r?\n/);
      const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
      const i10 = header.indexOf("10 Yr");
      const i30 = header.indexOf("30 Yr");
      const i2 = header.indexOf("2 Yr");
      for (const line of lines.slice(1)) {
        const c = line.split(",");
        const [mm, dd, yyyy] = c[0].replace(/"/g, "").split("/");
        yields[`${yyyy}-${mm}-${dd}`] = { y2: Number(c[i2]) || null, y10: Number(c[i10]) || null, y30: Number(c[i30]) || null };
      }
    } catch (e) {
      console.warn(`treasury fetch failed for ${y}: ${e}`);
    }
  }
  fs.writeFileSync(yieldsCache, JSON.stringify(yields, null, 1) + "\n");
}
const ydays = Object.keys(yields).sort();
const yieldChange = (day, key) => {
  const i = ydays.indexOf(day);
  if (i <= 0) return null;
  const a = yields[ydays[i]][key];
  const b = yields[ydays[i - 1]][key];
  return a != null && b != null ? Math.round((a - b) * 1000) / 10 : null;
};
const releaseDaysPath = path.join(outDir, "release-days.json");
const releaseDays = fs.existsSync(releaseDaysPath) ? JSON.parse(fs.readFileSync(releaseDaysPath, "utf8")).days || {} : {};
const shadowRegime = {};
for (const f of shadowFiles) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
    if (doc.regime) shadowRegime[f.slice(7, 17)] = doc.regime;
  } catch {
    // ignore
  }
}
const dteBand = (d) => (d == null ? "unk" : d <= 10 ? "dte0-10" : d <= 30 ? "dte11-30" : "dte31+");
const regimeDays = [];
const candidateHistory = {};
for (const f of files) {
  const day = f.slice(5, 15);
  const book = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  const bookRows = book.rows || [];
  if (!bookRows.length) continue;
  const tideObj = book.morning_tide_0855 || book.tide;
  const tide = typeof tideObj === "string" ? tideObj : tideObj?.bias ?? null;
  const sr = shadowRegime[day];
  const types = {};
  for (const r of bookRows) {
    const outcome = r.outcome || r.status;
    if (!["winner", "loser", "expired_flat"].includes(outcome)) continue;
    const src = String(r.source || r.row_origin || "");
    const late = /late/i.test(src) || (r.why_tags || []).includes("late print");
    const bucket = /morning/i.test(src) && !late ? "morning" : late ? "late" : "other";
    const dte = r.dte ?? (r.expiry ? Math.round((Date.parse(String(r.expiry).slice(0, 10)) - Date.parse(day)) / 86_400_000) : null);
    const key = `${r.type}|${dteBand(dte)}|${bucket}`;
    add((types[key] ||= blank()), outcome);
  }
  regimeDays.push({
    day,
    label: sr?.label ?? null,
    tide: sr?.tide ?? tide,
    us10yChangeBp: sr?.us10yChangeBp ?? yieldChange(day, "y10"),
    us30yChangeBp: sr?.us30yChangeBp ?? yieldChange(day, "y30"),
    calendarType: sr?.calendarType ?? releaseDays[day]?.type ?? "normal",
    calendarNote: releaseDays[day]?.note ?? null,
    types,
  });
  candidateHistory[day] = bookRows
    .filter((r) => r.option_chain || r.id)
    .map((r) => ({ c: r.option_chain || r.id, s: r.score ?? r.conviction ?? null, a: typeof r.ask_prem === "number" && typeof r.premium !== "undefined" ? Math.round(r.ask_prem) : null }));
}
const histDays = Object.keys(candidateHistory).sort().slice(-20);
fs.writeFileSync(
  path.join(outDir, "regime-days.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), note: "Per study day: regime features + outcome counts by pick type (side|dteBand|bucket). Built by scripts/build-study-summary.mjs.", days: regimeDays }, null, 1) + "\n",
);
fs.writeFileSync(
  path.join(outDir, "candidate-history.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), note: "Contracts that appeared on each study day (c=option_chain, s=score, a=ask-side premium).", days: Object.fromEntries(histDays.map((d) => [d, candidateHistory[d]])) }) + "\n",
);
console.log(`wrote regime-days.json (${regimeDays.length} days) and candidate-history.json (${histDays.length} days)`);
