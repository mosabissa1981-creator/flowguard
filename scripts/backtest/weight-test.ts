/**
 * Re-weighting test on the full candidate pools (study only; never touches live scoring).
 * For each replayed session: rebuild the Picks and Premove top 3 under (a) current weights and (b) a weight
 * proposal (study/weight-proposal.json: chips[].change = proposed − current delta), using the same ordering,
 * concentration caps and lockouts as live, then compare outcomes from datasets/candidate-outcomes.json.gz.
 * Usage: npx tsx --conditions=react-server scripts/backtest/weight-test.ts [--proposal=path] [--from=YYYY-MM-DD]
 */
import fs from "node:fs";

import { p, readJson, writeJson } from "./store";
import { candKey, loadPools, type CandOutcome } from "./candidates";
import type { Pool, PoolRow } from "./pools";

type Proposal = { generatedAt?: string; since?: string; through?: string; chips: { chip: string; change: number; currentDelta: number; proposedDelta: number }[] };

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const clamp = (v: number) => Math.max(0, Math.min(100, v));
const dtePref = (dte: number) => (dte >= 11 && dte <= 30 ? 0 : dte >= 31 && dte <= 45 ? 1 : dte <= 9 ? 3 : 2);

type Sim = PoolRow & { simScore: number; simRaw: number };

function reweight(r: PoolRow, change: Map<string, number>): Sim {
  if (!change.size) return { ...r, simScore: r.score, simRaw: r.rawScore };
  const c90 = r.chips.find((c) => c.id === "score-90");
  const d90 = c90?.delta ?? 6;
  const preChange = r.preActChips.reduce((s, id) => s + (change.get(id) ?? 0), 0);
  const has90 = Boolean(c90);
  const has90New = has90 ? clamp(r.preActRaw + preChange) >= 90 || clamp(r.preActRaw) < 90 /* keep if it was set by other means */ : clamp(r.preActRaw + preChange) >= 90 && clamp(r.preActRaw) < 90;
  const other = r.chips.filter((c) => c.id !== "score-90").reduce((s, c) => s + (change.get(c.id) ?? 0), 0);
  const raw = r.rawScore - (has90 ? d90 : 0) + other + (has90New ? d90 + (change.get("score-90") ?? 0) : 0);
  return { ...r, simRaw: Math.round(raw), simScore: Math.round(clamp(raw)) };
}

function order(list: Pool["list"]) {
  return (a: Sim, b: Sim) => {
    const late = (r: Sim) => (r.chips.some((c) => c.id === "late-print") ? 1 : 0);
    if (late(a) !== late(b)) return late(a) - late(b);
    if (b.simScore !== a.simScore) return b.simScore - a.simScore;
    if (b.simRaw !== a.simRaw) return b.simRaw - a.simRaw;
    const dd = dtePref(a.dte) - dtePref(b.dte);
    if (dd) return dd;
    if (list === "picks") return (b.premium ?? 0) - (a.premium ?? 0);
    const build = (r: Sim) => r.chips.filter((c) => ["building", "mid-size", "quiet"].includes(c.id)).length;
    if (build(b) !== build(a)) return build(b) - build(a);
    const jumbo = (r: Sim) => ((r.premium ?? 0) >= 750_000 ? 1 : 0);
    return jumbo(a) - jumbo(b);
  };
}

async function top3(pool: Pool, change: Map<string, number>): Promise<Sim[]> {
  if (pool.locked) return [];
  const { applyConcentrationCaps } = await import("@/lib/issuers");
  const sims = pool.rows.map((r) => reweight(r, change)).sort(order(pool.list));
  const { kept } = applyConcentrationCaps(sims.map((s) => ({ s, alert: { ticker: s.ticker, option_chain: s.contract, id: s.contract } })), pool.listCap, pool.caps);
  return kept.slice(0, 3).map((k) => k.s);
}

type Stat = { n: number; scored: number; winners: number; losers: number; flat: number; winPct: number | null; lossPct: number | null; flatPct: number | null; avgExitPct: number | null; avgT3: number | null; avgMaxGain: number | null };
function stat(rows: { o?: CandOutcome }[]): Stat {
  const dec = rows.filter((r) => r.o && ["winner", "loser", "flat"].includes(r.o.outcome));
  const w = dec.filter((r) => r.o!.outcome === "winner").length, l = dec.filter((r) => r.o!.outcome === "loser").length, f = dec.length - w - l;
  // Exit P&L under the backtest rule: +40% target, −25% stop, flat = close at the 3-session time stop (T+3, else latest).
  const exit = dec.map((r) => (r.o!.outcome === "winner" ? 40 : r.o!.outcome === "loser" ? -25 : r.o!.t3 ?? r.o!.t1 ?? 0));
  const avg = (v: (number | null)[]) => { const x = v.filter((n): n is number => n != null); return x.length ? Math.round((x.reduce((a, b) => a + b, 0) / x.length) * 10) / 10 : null; };
  const pct = (k: number) => (dec.length ? Math.round((k / dec.length) * 1000) / 10 : null);
  return { n: rows.length, scored: dec.length, winners: w, losers: l, flat: f, winPct: pct(w), lossPct: pct(l), flatPct: pct(f), avgExitPct: avg(exit), avgT3: avg(dec.map((r) => r.o!.t3)), avgMaxGain: avg(dec.map((r) => r.o!.maxGainPct)) };
}

async function main() {
  const propPath = arg("proposal", "/workspace/flowguard/study/weight-proposal.json");
  const from = arg("from", "0000-00-00");
  const prop = JSON.parse(fs.readFileSync(propPath, "utf8")) as Proposal;
  const change = new Map(prop.chips.filter((c) => c.change).map((c) => [c.chip, c.change]));
  const outcomes = readJson<Record<string, CandOutcome>>(p("datasets", "candidate-outcomes.json.gz")) ?? {};
  const days = loadPools().filter((d) => d.day >= from).sort((a, b) => a.day.localeCompare(b.day));
  type Pick = { day: string; list: string; contract: string; o?: CandOutcome; rank: number };
  const cur: Pick[] = [], prp: Pick[] = [];
  let mismatch = 0, daysChanged = 0, missing = 0, maxPoolRank = 0;
  const entered: Pick[] = [], left: Pick[] = [];
  for (const d of days) for (const pool of d.pools) {
    const a = await top3(pool, new Map());
    const b = await top3(pool, change);
    const shown = pool.locked ? [] : pool.rows.filter((r) => r.capRank != null && r.capRank <= 3).sort((x, y) => x.capRank! - y.capRank!).map((r) => r.contract);
    if (shown.join() !== a.map((r) => r.contract).join()) mismatch += 1;
    const mk = (r: Sim, i: number): Pick => ({ day: d.day, list: pool.list, contract: r.contract, o: outcomes[candKey(d.day, pool.list, r.contract)], rank: i + 1 });
    a.forEach((r, i) => cur.push(mk(r, i)));
    b.forEach((r, i) => { maxPoolRank = Math.max(maxPoolRank, r.poolRank); const pk = mk(r, i); prp.push(pk); if (!pk.o || pk.o.outcome === "no-data" || pk.o.outcome === "open") missing += 1; });
    const ak = new Set(a.map((r) => r.contract)), bk = new Set(b.map((r) => r.contract));
    if ([...bk].some((c) => !ak.has(c))) daysChanged += 1;
    b.forEach((r, i) => { if (!ak.has(r.contract)) entered.push(mk(r, i)); });
    a.forEach((r, i) => { if (!bk.has(r.contract)) left.push(mk(r, i)); });
  }
  const by = (xs: Pick[], list?: string) => stat(list ? xs.filter((x) => x.list === list) : xs);
  const doc = {
    generatedAt: new Date().toISOString(),
    proposal: { path: propPath, generatedAt: prop.generatedAt, since: prop.since, through: prop.through, changes: Object.fromEntries(change) },
    sessions: days.length, from: days[0]?.day ?? null, to: days[days.length - 1]?.day ?? null,
    sanity: { currentTop3MismatchVsLive: mismatch, proposedRowsWithoutOutcome: missing, deepestProposedPoolRank: maxPoolRank },
    listSessionsWhereTop3Changed: daysChanged,
    current: { picks: by(cur, "picks"), premove: by(cur, "premove"), combined: by(cur) },
    proposed: { picks: by(prp, "picks"), premove: by(prp, "premove"), combined: by(prp) },
    swaps: { entered: by(entered), left: by(left) },
    rule: "Outcome = option high ≥ +40% before low ≤ −25% within 3 sessions after the print day (else flat). Avg exit = +40 / −25 / T+3 close for flats. Study only — not financial advice.",
  };
  const stamp = new Date().toISOString().slice(0, 10);
  writeJson(p(`weight-test-${stamp}.json`), doc);
  const row = (name: string, s: Stat) => `| ${name} | ${s.n} | ${s.scored} | ${s.winners}/${s.losers}/${s.flat} | ${s.winPct ?? "—"} | ${s.lossPct ?? "—"} | ${s.avgExitPct ?? "—"} | ${s.avgT3 ?? "—"} | ${s.avgMaxGain ?? "—"} |`;
  const md = [
    `# Weight proposal re-test (top 3/day) — study only, not financial advice`,
    ``,
    `Proposal: ${propPath} (${prop.generatedAt ?? "?"}). Changes: ${[...change].map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ")}.`,
    `Sessions: ${doc.sessions} (${doc.from} → ${doc.to}). List-sessions where the top 3 changed: ${daysChanged}. Sanity: current-weight top 3 ≠ live replay in ${mismatch} list-sessions; proposed picks without an outcome: ${missing}; deepest proposed pool rank: ${maxPoolRank}.`,
    ``,
    `| Set | n | decided | W/L/F | Win % | Loss % | Avg exit % | Avg T+3 % | Avg max gain % |`,
    `|---|---:|---:|---|---:|---:|---:|---:|---:|`,
    row("Picks — current", doc.current.picks), row("Picks — proposed", doc.proposed.picks),
    row("Premove — current", doc.current.premove), row("Premove — proposed", doc.proposed.premove),
    row("Combined — current", doc.current.combined), row("Combined — proposed", doc.proposed.combined),
    row("Swapped in (proposed only)", doc.swaps.entered), row("Swapped out (current only)", doc.swaps.left),
    ``,
    doc.rule,
  ].join("\n");
  fs.writeFileSync(p(`weight-test-${stamp}.md`), md);
  console.log(md);
}

main().then(() => process.exit(0), (e) => { console.error(e?.stack ?? e); process.exit(1); });
