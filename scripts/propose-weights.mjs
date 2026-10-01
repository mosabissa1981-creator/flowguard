#!/usr/bin/env node
/**
 * weekly_reweight (PROPOSAL ONLY). Re-reads the study books and proposes score-chip weight changes from
 * outcome lift. Writes study/weight-proposal.json (served at /api/weights-proposal) and
 * study/weight-proposal-YYYY-MM-DD.md. It NEVER edits lib/scoring.ts — a human applies changes by PR.
 *
 * Usage: node scripts/propose-weights.mjs [studyDir] [--since 2026-09-04] [--min-n 8] [--max-step 4]
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const studyDir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--")) || "study";
const since = flag("--since", "2026-09-04");
const minN = Number(flag("--min-n", "8"));
const maxStep = Number(flag("--max-step", "4"));
const repoStudy = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "study");

const files = fs.readdirSync(studyDir).filter((f) => /^book-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(5, 15) >= since).sort();
const rows = [];
for (const f of files) {
  const book = JSON.parse(fs.readFileSync(path.join(studyDir, f), "utf8"));
  for (const r of book.rows || []) {
    const outcome = r.outcome || r.status;
    if (!["winner", "loser", "expired_flat"].includes(outcome)) continue;
    const chips = (r.chips || []).map((c) => (typeof c === "string" ? { id: c, delta: null } : { id: c.id, delta: typeof c.delta === "number" ? c.delta : null }));
    if (!chips.length) continue; // rows without chip data cannot inform weights (and would skew the base rate)
    rows.push({ day: f.slice(5, 15), outcome, pct: typeof r.outcome_pct === "number" ? r.outcome_pct : null, chips });
  }
}
const base = { n: rows.length, w: rows.filter((r) => r.outcome === "winner").length, l: rows.filter((r) => r.outcome === "loser").length };
const baseWin = base.n ? base.w / base.n : 0;
const baseLoss = base.n ? base.l / base.n : 0;

const ids = new Map();
for (const r of rows) for (const c of r.chips) {
  const e = ids.get(c.id) || { id: c.id, n: 0, w: 0, l: 0, flat: 0, deltas: [] };
  e.n += 1;
  if (r.outcome === "winner") e.w += 1;
  else if (r.outcome === "loser") e.l += 1;
  else e.flat += 1;
  if (c.delta != null) e.deltas.push(c.delta);
  ids.set(c.id, e);
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const chips = [...ids.values()]
  .map((e) => {
    const winRate = e.w / e.n;
    const lossRate = e.l / e.n;
    // Expected value proxy: +1 per winner, −1 per loser, 0 flat, vs the base rate; shrunk toward 0 for small n.
    const ev = winRate - lossRate - (baseWin - baseLoss);
    const shrink = e.n / (e.n + 20);
    const step = e.n >= minN ? Math.max(-maxStep, Math.min(maxStep, Math.round(ev * shrink * 20))) : 0;
    const current = median(e.deltas);
    return {
      chip: e.id,
      n: e.n,
      record: `${e.w}W/${e.l}L/${e.flat}F`,
      winRatePct: Math.round(winRate * 1000) / 10,
      lossRatePct: Math.round(lossRate * 1000) / 10,
      evVsBase: Math.round(ev * 1000) / 1000,
      currentDelta: current,
      proposedDelta: current == null ? null : current + step,
      change: step,
      note: e.n < minN ? `n<${minN}: no change proposed` : step === 0 ? "keep" : step > 0 ? "outperformed base rate" : "underperformed base rate",
    };
  })
  .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || b.n - a.n);

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const proposal = {
  status: "proposal",
  applied: false,
  generatedAt: new Date().toISOString(),
  since,
  through: rows.length ? rows[rows.length - 1].day : null,
  rows: base.n,
  base: { winRatePct: Math.round(baseWin * 1000) / 10, lossRatePct: Math.round(baseLoss * 1000) / 10 },
  method: `Per chip: (win rate − loss rate) minus the base rate, shrunk by n/(n+20), ×20 → integer step clamped to ±${maxStep}; only chips with n ≥ ${minN}. Proposal only — apply by editing lib/scoring.ts in a reviewed PR.`,
  caveats: [
    "Small sample; outcomes are EOD-check based (±15%), chips are correlated (e.g. ask-dom with sweep).",
    "Late prints dominate the flat bucket; consider bucket-specific weights before changing global ones.",
  ],
  chips,
};
fs.writeFileSync(path.join(repoStudy, "weight-proposal.json"), JSON.stringify(proposal, null, 2) + "\n");
const md = [
  `# Weight proposal — ${today} (NOT applied)`,
  "",
  `Rows: ${base.n} scored rows with chips (winner/loser/flat) since ${since}. Base win ${proposal.base.winRatePct}% / loss ${proposal.base.lossRatePct}%.`,
  "",
  "| chip | n | record | win% | loss% | current | proposed | note |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...chips.map((c) => `| ${c.chip} | ${c.n} | ${c.record} | ${c.winRatePct} | ${c.lossRatePct} | ${c.currentDelta ?? "?"} | ${c.proposedDelta ?? "?"} | ${c.note} |`),
  "",
  proposal.method,
].join("\n");
fs.writeFileSync(path.join(repoStudy, `weight-proposal-${today}.md`), md + "\n");
console.log(`proposal: ${chips.filter((c) => c.change !== 0).length} chip changes proposed from ${base.n} rows → study/weight-proposal.json`);
