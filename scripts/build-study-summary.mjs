#!/usr/bin/env node
/**
 * Build study/study-summary.json from the desk study books (book-YYYY-MM-DD.json).
 * Usage: node scripts/build-study-summary.mjs [studyDir] [--since 2026-09-23] [--recent 40]
 * The AI-picks prompt reads this file (and /api/study-summary serves it).
 * Also: shadowAccuracy (from study/shadow-*.json), study/regime-days.json, study/candidate-history.json.
 * Lottery (test mode): study/lottery-YYYY-MM-DD.json (saved daily from /api/lottery/track) -> summary.lottery,
 *   scored over multi-day horizons (max gain reached, +100/+300/+1000% hits, expired-worthless rate). Kept out of totals.
 * Puts (test mode): study/puts-YYYY-MM-DD.json (saved daily from /api/puts/track) -> summary.puts,
 *   win/loss/flat at +40% target / -25% stop within 3 sessions, T+1..T+5 returns, by regime label and tide. Kept out of totals.
 * Setup lanes (test mode): study/lanes-YYYY-MM-DD.json (saved daily from /api/lanes/track) -> summary.lanes[<laneId>],
 *   W/L/flat at +40% / -25% within each lane's time stop, win rate, avg T+1/T+3/T+5, by regime. Kept out of totals.
 * Lane debate (shadow): study/lane-debate-YYYY-MM-DD.json (from /api/shadow/lanes?day=) -> summary.laneDebate,
 *   TAKE vs SKIP outcome mix per lane and per side, joined to puts-/lanes- tracking outcomes.
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

// ---------------------------------------------------------------------------
// Puts lane (TEST mode). Each daily file is the full cumulative /api/puts/track snapshot; newest tracking wins.
// ---------------------------------------------------------------------------
const putsFiles = fs.readdirSync(studyDir).filter((f) => /^puts-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const putsByKey = new Map();
for (const f of putsFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  } catch {
    continue;
  }
  for (const e of doc.entries || []) {
    if (!e || !e.contract || !e.day) continue;
    const k = `${e.day}|${e.contract}`;
    const prev = putsByKey.get(k);
    if (!prev || !prev.tracking || (e.tracking && String(e.tracking.asOf) >= String(prev.tracking.asOf))) putsByKey.set(k, e);
  }
}
const putsEntries = [...putsByKey.values()].sort((a, b) => (a.day + a.contract).localeCompare(b.day + b.contract));
const putStats = (list) => {
  const t = list.map((e) => e.tracking).filter(Boolean);
  const c = (o) => t.filter((x) => x.outcome === o).length;
  const w = c("winner");
  const l = c("loser");
  const fl = c("flat");
  const avg = (k) => {
    const v = t.map((x) => x.returns?.[k]).filter((n) => typeof n === "number");
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const n = w + l + fl;
  return { n: list.length, w, l, flat: fl, open: list.length - n, winRate: n ? Math.round((w / n) * 1000) / 10 : null, lossRate: n ? Math.round((l / n) * 1000) / 10 : null, avgT1: avg("t1"), avgT3: avg("t3"), avgT5: avg("t5") };
};
const putGroup = (keyFn) => {
  const m = {};
  for (const e of putsEntries) (m[keyFn(e)] ||= []).push(e);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, putStats(v)]));
};
summary.puts = {
  mode: "test",
  files: putsFiles.length,
  days: [...new Set(putsEntries.map((e) => e.day))],
  definition:
    "Separate from the same-day ±15% book. Entry = flow print. Within a 3-session time stop: winner = option high ≥ +40% first, loser = low ≤ −25% first (same session both = loser), flat = neither. T+1..T+5 = closes vs entry.",
  overall: putStats(putsEntries),
  byRegime: putGroup((e) => e.regimeLabel ?? "unknown"),
  byMarketTide: putGroup((e) => e.marketTide ?? "unknown"),
  byTickerTide: putGroup((e) => e.tickerTide ?? "unknown"),
  byConfirmation: putGroup((e) => (e.confirmations || []).slice().sort().join("+") || "none"),
  byYields: putGroup((e) => (e.yieldsRising == null ? "unknown" : e.yieldsRising ? "rising" : "not-rising")),
  entries: putsEntries.slice(-40).map((e) => ({
    day: e.day,
    contract: e.contract,
    entry: e.entry ?? e.price,
    regime: e.regimeLabel ?? null,
    tide: `${e.marketTide ?? "?"}/${e.tickerTide ?? "?"}`,
    confirmations: e.confirmations || [],
    outcome: e.tracking?.outcome ?? "open",
    returns: e.tracking?.returns ?? null,
    maxGainPct: e.tracking?.maxGainPct ?? null,
  })),
};

// ---------------------------------------------------------------------------
// Setup lanes (TEST mode). Each daily file = full cumulative /api/lanes/track snapshot { lanes: [{ lane, entries }] }.
// Reuses putStats (same tracking shape: tracking.outcome + tracking.returns).
// ---------------------------------------------------------------------------
const laneFiles = fs.readdirSync(studyDir).filter((f) => /^lanes-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const laneEntries = new Map(); // laneId -> Map(day|contract -> entry)
for (const f of laneFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  } catch {
    continue;
  }
  for (const ln of doc.lanes || []) {
    const id = ln.lane;
    if (!id) continue;
    const m = laneEntries.get(id) || new Map();
    for (const e of ln.entries || []) {
      if (!e || !e.contract || !e.day) continue;
      const k = `${e.day}|${e.contract}`;
      const prev = m.get(k);
      if (!prev || !prev.tracking || (e.tracking && String(e.tracking.asOf) >= String(prev.tracking.asOf))) m.set(k, e);
    }
    laneEntries.set(id, m);
  }
}
summary.lanes = {
  mode: "test",
  files: laneFiles.length,
  definition:
    "Separate from the same-day ±15% book. Entry = flow print. Within each lane's time stop (earnings lanes 5 sessions, capped to exit before the report; others 3): winner = option high ≥ +40% first, loser = low ≤ −25% first (same session both = loser), flat = neither. T+1..T+5 = closes vs entry.",
  byLane: Object.fromEntries(
    [...laneEntries.entries()].map(([id, m]) => {
      const list = [...m.values()].sort((a, b) => (a.day + a.contract).localeCompare(b.day + b.contract));
      const byRegime = {};
      for (const e of list) (byRegime[e.regimeLabel ?? "unknown"] ||= []).push(e);
      return [
        id,
        {
          ...putStats(list),
          days: [...new Set(list.map((e) => e.day))],
          byRegime: Object.fromEntries(Object.entries(byRegime).map(([k, v]) => [k, putStats(v)])),
          recent: list.slice(-15).map((e) => ({ day: e.day, contract: e.contract, entry: e.entry ?? e.price, outcome: e.tracking?.outcome ?? "open", t1: e.tracking?.returns?.t1 ?? null, t3: e.tracking?.returns?.t3 ?? null })),
        },
      ];
    }),
  ),
};

// ---------------------------------------------------------------------------
// Lane debate (shadow) — scores TAKE vs SKIP verdicts against TEST-lane outcomes (puts + setup lanes).
// ---------------------------------------------------------------------------
const laneOutcome = new Map(); // `${lane}|${day}|${contract}` -> tracking
for (const e of putsEntries) if (e.tracking) laneOutcome.set(`puts|${e.day}|${e.contract}`, e.tracking);
for (const [id, m] of laneEntries) for (const e of m.values()) if (e.tracking) laneOutcome.set(`${id}|${e.day}|${e.contract}`, e.tracking);
const debateFiles = fs.readdirSync(studyDir).filter((f) => /^lane-debate-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const dbBlank = () => ({ take: { w: 0, l: 0, flat: 0, open: 0 }, skip: { w: 0, l: 0, flat: 0, open: 0 } });
const dbByLane = {};
const dbBySide = { call: dbBlank(), put: dbBlank() };
let dbVerdicts = 0;
let dbSpend = 0;
const dbAdd = (b, verdict, t) => {
  const k = verdict === "take" ? "take" : "skip";
  const o = t?.outcome;
  if (o === "winner") b[k].w += 1;
  else if (o === "loser") b[k].l += 1;
  else if (o === "flat") b[k].flat += 1;
  else b[k].open += 1;
};
for (const f of debateFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  } catch {
    continue;
  }
  dbSpend += doc.llm?.spendUsd ?? 0;
  for (const v of Object.values(doc.verdicts || {})) {
    dbVerdicts += 1;
    const t = laneOutcome.get(`${v.lane}|${doc.day}|${v.contract}`);
    dbAdd((dbByLane[v.lane] ||= dbBlank()), v.verdict, t);
    if (dbBySide[v.side]) dbAdd(dbBySide[v.side], v.verdict, t);
  }
}
const dbRates = (b) => {
  const r = (x) => {
    const n = x.w + x.l + x.flat;
    return { ...x, decided: n, winRate: n ? Math.round((x.w / n) * 1000) / 10 : null, lossRate: n ? Math.round((x.l / n) * 1000) / 10 : null };
  };
  const take = r(b.take);
  const skip = r(b.skip);
  return { take, skip, edge: take.decided && skip.decided ? { takeWinRate: take.winRate, skipWinRate: skip.winRate, takeLossRate: take.lossRate, skipLossRate: skip.lossRate } : null };
};
summary.laneDebate = {
  mode: "shadow",
  files: debateFiles.length,
  verdicts: dbVerdicts,
  spendUsd: Math.round(dbSpend * 10000) / 10000,
  definition: "Direction-aware bull/bear/macro debate → TAKE/SKIP per TEST-lane pick (never changes picks). Outcomes from the lane trackers (+40% / -25% within the lane time stop). A useful debate has take win rate > skip win rate.",
  byLane: Object.fromEntries(Object.entries(dbByLane).map(([k, b]) => [k, dbRates(b)])),
  bySide: { call: dbRates(dbBySide.call), put: dbRates(dbBySide.put) },
};

// ---------------------------------------------------------------------------
// Lottery lane (TEST mode). Separate from the +/-15% same-day book: each daily file is the full
// cumulative /api/lottery/track snapshot, so the newest tracking per (day, contract) wins.
// ---------------------------------------------------------------------------
const lotteryFiles = fs.readdirSync(studyDir).filter((f) => /^lottery-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const lotteryByKey = new Map();
for (const f of lotteryFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  } catch {
    continue;
  }
  for (const e of doc.entries || []) {
    if (!e || !e.contract || !e.day) continue;
    const k = `${e.day}|${e.contract}`;
    const prev = lotteryByKey.get(k);
    if (!prev || !prev.tracking || (e.tracking && String(e.tracking.asOf) >= String(prev.tracking.asOf))) lotteryByKey.set(k, e);
  }
}
const lotteryEntries = [...lotteryByKey.values()].sort((a, b) => (a.day + a.contract).localeCompare(b.day + b.contract));
const lotStats = (list) => {
  const tracked = list.filter((e) => e.tracking);
  const finals = tracked.filter((e) => e.tracking.final);
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const gains = tracked.map((e) => e.tracking.maxGainPct).filter((g) => typeof g === "number").sort((a, b) => a - b);
  const hits = (k) => tracked.filter((e) => e.tracking[k]).length;
  const worthless = finals.filter((e) => e.tracking.expiredWorthless).length;
  return {
    n: list.length,
    tracked: tracked.length,
    final: finals.length,
    hit100: hits("hit100"),
    hit300: hits("hit300"),
    hit1000: hits("hit1000"),
    hit100Rate: pct(hits("hit100"), tracked.length),
    hit300Rate: pct(hits("hit300"), tracked.length),
    hit1000Rate: pct(hits("hit1000"), tracked.length),
    expiredWorthless: worthless,
    expiredWorthlessRate: pct(worthless, finals.length),
    medianMaxGainPct: gains.length ? gains[Math.floor(gains.length / 2)] : null,
  };
};
const lotGroup = (keyFn) => {
  const m = {};
  for (const e of lotteryEntries) (m[keyFn(e)] ||= []).push(e);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, lotStats(v)]));
};
summary.lottery = {
  mode: "test",
  files: lotteryFiles.length,
  days: [...new Set(lotteryEntries.map((e) => e.day))],
  definition:
    "Multi-day horizon, not same-day W/L. Entry = flow print. maxGainPct = best daily high after the entry day vs entry; hit100/300/1000 = reached +100/+300/+1000% at any point before expiry; expiredWorthless = expired with last <= max($0.05, 10% of entry). Rates over tracked (hits) / final (worthless) entries.",
  overall: lotStats(lotteryEntries),
  byCatalyst: lotGroup((e) => e.catalyst?.kind ?? "none"),
  bySide: lotGroup((e) => e.side || "unk"),
  byPriceBand: lotGroup((e) => ((e.entry ?? e.price) >= 0.1 && (e.entry ?? e.price) <= 0.6 ? "0.10-0.60" : "other")),
  byDte: lotGroup((e) => (e.dte <= 10 ? "5-10" : e.dte <= 20 ? "11-20" : "21-30")),
  topRunners: lotteryEntries
    .filter((e) => typeof e.tracking?.maxGainPct === "number")
    .sort((a, b) => b.tracking.maxGainPct - a.tracking.maxGainPct)
    .slice(0, 10)
    .map((e) => ({ day: e.day, contract: e.contract, entry: e.entry ?? e.price, maxHigh: e.tracking.maxHigh, maxGainPct: e.tracking.maxGainPct, maxHighDate: e.tracking.maxHighDate, catalyst: e.catalyst?.kind ?? null })),
  entries: lotteryEntries.slice(-40).map((e) => ({
    day: e.day,
    contract: e.contract,
    entry: e.entry ?? e.price,
    dte: e.dte,
    catalyst: e.catalyst ? `${e.catalyst.kind} ${e.catalyst.date}` : null,
    maxGainPct: e.tracking?.maxGainPct ?? null,
    last: e.tracking?.last ?? null,
    final: e.tracking?.final ?? false,
    expiredWorthless: e.tracking?.expiredWorthless ?? null,
  })),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(`wrote ${out}: ${rows.length} rows, ${decided.length} decided, ${clusters.length} clusters`);
console.log(`puts (test): ${putsFiles.length} file(s), ${putsEntries.length} logged, W/L/F ${summary.puts.overall.w}/${summary.puts.overall.l}/${summary.puts.overall.flat}`);
console.log(`setup lanes (test): ${laneFiles.length} file(s), ${Object.keys(summary.lanes.byLane).length} lane(s)`);
console.log(`lane debate (shadow): ${debateFiles.length} file(s), ${dbVerdicts} verdict(s)`);
console.log(`lottery (test): ${lotteryFiles.length} file(s), ${lotteryEntries.length} logged picks, ${summary.lottery.overall.final} final`);
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
