/**
 * Candidate dataset (study only): every stored Picks/Premove pool row (pools/<day>.json) with its chips,
 * scores and — for rows down to CAND_DEPTH (default 25) in each day's pool — the same outcome rule as the logged picks
 * (option high ≥ +40% before low ≤ −25% within 3 sessions; flat otherwise).
 *   datasets/candidate-outcomes.json.gz  (resumable outcome cache, keyed day|list|contract)
 *   datasets/candidates.csv              (one row per pool row; chip_<id> columns hold the chip delta, blank = absent)
 * Contract histories come from the shared contracts/ cache; misses cost 1 budgeted UW call each (BudgetStop-safe).
 * Standalone: npx tsx --conditions=react-server scripts/backtest/candidates.ts [--depth=25]  (UW_OFFLINE=1 = cache only)
 */
import fs from "node:fs";

import { BudgetStop, budget } from "./uw-budget";
import { addDays, contractHistory, p, readJson, writeJson } from "./store";
import type { Pool, PoolRow } from "./pools";
import type { PoolsDay } from "./replay";

const candDepth = () => Number(process.env.CAND_DEPTH || 25);

export type CandOutcome = {
  outcome: "winner" | "loser" | "flat" | "open" | "no-data";
  outcomeSession: number | null;
  t1: number | null; t3: number | null; t5: number | null;
  maxGainPct: number | null; maxDrawdownPct: number | null;
  final: boolean;
};

export const candKey = (day: string, list: string, contract: string) => `${day}|${list}|${contract}`;

export function loadPools(): PoolsDay[] {
  if (!fs.existsSync(p("pools"))) return [];
  return fs.readdirSync(p("pools")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse()
    .map((f) => readJson<PoolsDay>(p("pools", f))).filter((d): d is PoolsDay => Boolean(d?.pools));
}

async function outcomeFor(r: PoolRow, day: string, today: string): Promise<CandOutcome> {
  const { parseHistoricBar } = await import("@/lib/uw");
  const lanes = await import("@/lib/lanes");
  const empty: CandOutcome = { outcome: "no-data", outcomeSession: null, t1: null, t3: null, t5: null, maxGainPct: null, maxDrawdownPct: null, final: false };
  if (!(r.entry > 0) || !/^[A-Z.]+\d{6}[CP]\d{8}$/.test(r.contract)) return { ...empty, final: true };
  const chains = await contractHistory(r.contract, addDays(day, 12), today);
  if (!chains?.length) return empty;
  const bars = chains.map((c) => parseHistoricBar(c)).sort((a, b) => a.date.localeCompare(b.date));
  const t = lanes.trackFromBars({ day, entry: r.entry, expiry: r.expiry, exitPlan: { timeStopSessions: 3 } } as never, bars, today);
  return { outcome: t.outcome, outcomeSession: t.outcomeSession, t1: t.returns.t1, t3: t.returns.t3, t5: t.returns.t5, maxGainPct: t.maxGainPct, maxDrawdownPct: t.maxDrawdownPct, final: t.final || t.outcome === "winner" || t.outcome === "loser" };
}

/** Score pool rows (shown top 3 first, then by pool rank, newest day first). Stops quietly at the UW budget. */
export async function scoreCandidates(today: string, log: (...a: unknown[]) => void = console.log): Promise<{ scored: number; stopped: boolean }> {
  const file = p("datasets", "candidate-outcomes.json.gz");
  const cache = readJson<Record<string, CandOutcome>>(file) ?? {};
  const days = loadPools();
  const depth = candDepth();
  const queue: { day: string; list: string; r: PoolRow; pri: number }[] = [];
  for (const d of days) for (const pool of d.pools) for (const r of pool.rows) {
    if (r.poolRank > depth && !(r.capRank != null && r.capRank <= 3)) continue;
    if (cache[candKey(d.day, pool.list, r.contract)]?.final) continue;
    queue.push({ day: d.day, list: pool.list, r, pri: r.capRank != null && r.capRank <= 3 ? 0 : r.poolRank });
  }
  queue.sort((a, b) => a.pri - b.pri || b.day.localeCompare(a.day));
  let scored = 0;
  let stopped = false;
  for (const q of queue) {
    try {
      cache[candKey(q.day, q.list, q.r.contract)] = await outcomeFor(q.r, q.day, today);
      scored += 1;
    } catch (e) {
      if (e instanceof BudgetStop || (e as Error)?.name === "BudgetStop") {
        stopped = true;
        break;
      }
      throw e;
    }
    if (scored % 1000 === 0) {
      writeJson(file, cache);
      log(`candidates: ${scored}/${queue.length} scored (UW count ${budget.tokenCountToday})`);
    }
  }
  writeJson(file, cache);
  writeCandidatesCsv(days, cache);
  log(`candidates: ${scored} scored this run, ${queue.length - scored} pending${stopped ? " (budget stop)" : ""}`);
  return { scored, stopped };
}

export function writeCandidatesCsv(days: PoolsDay[], cache: Record<string, CandOutcome>) {
  const chipIds = [...new Set(days.flatMap((d) => d.pools.flatMap((pl) => pl.rows.flatMap((r) => r.chips.map((c) => c.id)))))].sort();
  const cols = ["day", "list", "locked", "listCap", "poolRank", "capRank", "shown", "contract", "ticker", "side", "expiry", "entry", "printTimeUtc", "underlying", "score", "rawScore", "preActRaw", "dte", "askShare", "premium", "volOi", "sweep", "chips", "preActChips", ...chipIds.map((c) => `chip_${c}`), "outcome", "outcomeSession", "t1", "t3", "t5", "maxGainPct", "maxDrawdownPct", "final"];
  const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(",")];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) for (const pool of d.pools as Pool[]) for (const r of pool.rows) {
    const o = cache[candKey(d.day, pool.list, r.contract)];
    const chipMap = Object.fromEntries(r.chips.map((c) => [`chip_${c.id}`, c.delta]));
    const rec: Record<string, unknown> = {
      ...r, ...chipMap, day: d.day, list: pool.list, locked: pool.locked, listCap: pool.listCap,
      shown: !pool.locked && r.capRank != null && r.capRank <= 3,
      chips: r.chips.map((c) => `${c.id}:${c.delta}`).join(";"), preActChips: r.preActChips.join(";"),
      outcome: o?.outcome ?? "unscored", outcomeSession: o?.outcomeSession, t1: o?.t1, t3: o?.t3, t5: o?.t5, maxGainPct: o?.maxGainPct, maxDrawdownPct: o?.maxDrawdownPct, final: o?.final ?? false,
    };
    lines.push(cols.map((c) => esc(rec[c])).join(","));
  }
  fs.writeFileSync(p("datasets", "candidates.csv"), lines.join("\n"));
}

if (process.argv[1]?.endsWith("candidates.ts")) {
  const depth = process.argv.find((a) => a.startsWith("--depth="));
  if (depth) process.env.CAND_DEPTH = depth.split("=")[1];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  scoreCandidates(today).then(
    () => process.exit(0),
    (e) => {
      console.error("candidates fatal", e?.stack ?? e);
      process.exit(1);
    },
  );
}
