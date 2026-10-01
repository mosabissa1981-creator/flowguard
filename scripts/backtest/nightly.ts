/**
 * FlowGuard nightly history job (box only). Run via scripts/backtest/run-nightly.sh after the 8 pm ET UW reset.
 *
 *  1. Outcomes: refresh contract histories for replayed entries whose T+1..T+5 window is not final yet.
 *  2. Backfill: newest → oldest trading day inside the 2-year lookback: flow alerts (≥ $10K, compact) + market tide,
 *     then replay the current lane/picks/premove rules on that day (fake clock, no UW calls except lazy daily
 *     bars / earnings lookups, cached forever).
 *  3. Outcomes for the new entries, then summary + ML dataset.
 * Stops cleanly at the UW budget (x-uw-daily-req-count ≥ UW_STOP_AT, default 37,500; hard ceiling 39,000 − 1,500 reserve).
 * Resumable: every finished day / contract is a file; re-running skips them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { budget, BudgetStop, STOP_AT } from "./uw-budget";
import { addDays, contractHistory, darkPoolWindow, gexStrikes, insiderRows, netPremTicks, ensureDirs, fetchFlowDay, fetchTideDay, loadFlowDay, p, readJson, ROOT, writeJson } from "./store";
import type { ReplayDay, ReplayEntry } from "./replay-types";

const args = new Map(process.argv.slice(2).map((a) => (a.includes("=") ? (a.replace(/^--/, "").split("=") as [string, string]) : [a.replace(/^--/, ""), "1"])));
const MAX_DAYS = Number(args.get("days") || 1e9);
const LOOKBACK_START = args.get("from") || "";
const NO_FETCH = args.has("no-fetch");
const SUMMARY_ONLY = args.has("summary-only");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}
function isWeekday(day: string) {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}
/** Trading days strictly before today, newest first, back to the 2-year lookback. */
function candidateDays(today: string): string[] {
  const start = LOOKBACK_START || addDays(today, -730 + 3);
  const out: string[] = [];
  for (let d = addDays(today, -1); d >= start; d = addDays(d, -1)) if (isWeekday(d)) out.push(d);
  return out;
}
const replayFile = (day: string) => p("replay", `${day}.json`);
const holidayFile = p("holidays.json");

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------
type Outcome = ReplayEntry & {
  outcome: "winner" | "loser" | "flat" | "open" | "no-data";
  outcomeSession: number | null;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  t1: number | null; t3: number | null; t5: number | null;
  oiChangeT1Pct: number | null; // open-interest follow-through on the next session (shadow signal)
  sig?: { v?: number; dp: string | null; gex: string | null; oi: string | null; insider?: string | null; netPrem?: string | null; flex?: string | null; dpPremiumUsd?: number | null; gexRegime?: string | null; roomPct?: number | null; netPremUsd?: number | null; insiderBuyUsd?: number | null; insiderSellUsd?: number | null; flexOi?: number | null };
  final: boolean;
};

type Bar = { date: string; last: number | null; high: number | null; low: number | null; openInterest: number | null; volume: number | null; flexOiTransfer: number | null };

async function barsFor(e: ReplayEntry, today: string): Promise<Bar[] | null> {
  const { parseHistoricBar } = await import("@/lib/uw");
  const chains = await contractHistory(e.contract, addDays(e.day, 12), today);
  if (!chains) return null;
  return chains.map((c) => parseHistoricBar(c)).map((b) => ({ date: b.date, last: b.last, high: b.high, low: b.low, openInterest: b.openInterest, volume: b.volume, flexOiTransfer: b.flexOiTransfer ?? null })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Dark pool / GEX / OI follow-through for LOGGED entries only (candidates skip the extra UW calls). */
async function shadowSignals(e: ReplayEntry, bars: Bar[], dayBar: Bar | null, next: Bar | null): Promise<Outcome["sig"]> {
  const core = await import("@/lib/shadow/signals-core");
  const oi = core.oiSignal(dayBar?.openInterest ?? null, next?.openInterest ?? null, dayBar?.volume ?? null).verdict;
  const fl = core.flexSignal(bars, e.day);
  const base = { v: 2, dp: null, gex: null, oi, insider: null, netPrem: null, flex: fl.verdict, flexOi: fl.transferredOi };
  if (e.kind !== "logged" || !e.printTimeUtc) return base;
  const printMs = Date.parse(e.printTimeUtc);
  const strike = Number(e.contract.slice(-8)) / 1000;
  const out: NonNullable<Outcome["sig"]> = { ...base };
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof BudgetStop) throw err;
    }
  };
  await guard(async () => {
    const d = core.darkPoolSignal(core.parseDarkPool(await darkPoolWindow(e.ticker, e.day, printMs)), e.side, printMs);
    out.dp = d.verdict;
    out.dpPremiumUsd = d.premiumUsd;
  });
  await guard(async () => {
    const g = core.gexSignal(core.parseGexStrikes(await gexStrikes(e.ticker, e.day)), e.underlying ?? 0, e.side, strike);
    out.gex = g?.verdict ?? null;
    out.gexRegime = g?.regime ?? null;
    out.roomPct = g?.roomPct ?? null;
  });
  await guard(async () => {
    const n = core.netPremSignal((await netPremTicks(e.ticker, e.day)) as never, e.side, printMs);
    out.netPrem = n.verdict;
    out.netPremUsd = n.netPremium;
  });
  await guard(async () => {
    const i = core.insiderSignal(await insiderRows(e.ticker), e.side, e.day);
    out.insider = i.verdict;
    out.insiderBuyUsd = i.buyUsd;
    out.insiderSellUsd = i.sellUsd;
  });
  return out;
}

async function scoreEntry(e: ReplayEntry, today: string): Promise<Outcome> {
  const lanes = await import("@/lib/lanes");
  const lottery = await import("@/lib/lottery");
  const bars = await barsFor(e, today);
  const base = { ...e, outcome: "no-data" as Outcome["outcome"], outcomeSession: null, maxGainPct: null, maxDrawdownPct: null, t1: null, t3: null, t5: null, oiChangeT1Pct: null, final: false };
  if (!bars?.length) return base;
  const dayBar = bars.find((b) => b.date === e.day);
  const next = bars.find((b) => b.date > e.day);
  const oi = dayBar?.openInterest && next?.openInterest != null ? Math.round(((next.openInterest - dayBar.openInterest) / dayBar.openInterest) * 1000) / 10 : null;
  const sig = await shadowSignals(e, bars, dayBar ?? null, next ?? null);
  if (e.lane === "lottery") {
    const t = lottery.trackFromBars({ day: e.day, entry: e.entry, expiry: e.expiry } as never, bars, today);
    const outcome: Outcome["outcome"] = t.hit100 ? "winner" : t.final ? "loser" : "open";
    return { ...base, outcome, maxGainPct: t.maxGainPct, oiChangeT1Pct: oi, sig, final: t.final || t.hit100 };
  }
  const t = lanes.trackFromBars({ day: e.day, entry: e.entry, expiry: e.expiry, exitPlan: { timeStopSessions: e.timeStopSessions || 3 } } as never, bars, today);
  return { ...base, outcome: t.outcome, outcomeSession: t.outcomeSession, maxGainPct: t.maxGainPct, maxDrawdownPct: t.maxDrawdownPct, t1: t.returns.t1, t3: t.returns.t3, t5: t.returns.t5, oiChangeT1Pct: oi, sig, final: t.final || t.outcome === "winner" || t.outcome === "loser" };
}

async function scoreAll(today: string): Promise<Outcome[]> {
  const outFile = p("datasets", "outcomes.json.gz");
  const prev = new Map((readJson<Outcome[]>(outFile) ?? []).map((o) => [`${o.day}|${o.lane}|${o.kind}|${o.contract}`, o]));
  const all: Outcome[] = [];
  const files = fs.readdirSync(p("replay")).filter((f) => f.endsWith(".json")).sort().reverse();
  let stopped = false;
  for (const f of files) {
    const r = readJson<ReplayDay>(p("replay", f));
    for (const e of r?.entries ?? []) {
      const k = `${e.day}|${e.lane}|${e.kind}|${e.contract}`;
      const old = prev.get(k);
      if ((old?.final && old.sig?.v === 2) || stopped) {
        all.push(old ?? { ...e, outcome: "open", outcomeSession: null, maxGainPct: null, maxDrawdownPct: null, t1: null, t3: null, t5: null, oiChangeT1Pct: null, final: false });
        continue;
      }
      try {
        all.push(await scoreEntry(e, today));
      } catch (err) {
        if (err instanceof BudgetStop) {
          stopped = true;
          all.push(old ?? { ...e, outcome: "open", outcomeSession: null, maxGainPct: null, maxDrawdownPct: null, t1: null, t3: null, t5: null, oiChangeT1Pct: null, final: false });
        } else throw err;
      }
    }
  }
  writeJson(outFile, all);
  return all;
}

function summarize(all: Outcome[]) {
  const byLane = new Map<string, Outcome[]>();
  for (const o of all) byLane.set(o.lane, [...(byLane.get(o.lane) ?? []), o]);
  const rows = [...byLane.entries()].sort().map(([lane, xs]) => {
    const c = (k: Outcome["outcome"]) => xs.filter((x) => x.outcome === k).length;
    const w = c("winner"), l = c("loser"), f = c("flat");
    const decided = w + l + f;
    const avg = (k: "t1" | "t3" | "maxGainPct") => {
      const v = xs.map((x) => x[k]).filter((n): n is number => n != null);
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    };
    const oiUp = xs.filter((x) => x.oiChangeT1Pct != null && x.oiChangeT1Pct > 0);
    const oiWin = oiUp.filter((x) => x.outcome === "winner").length;
    const oiDec = oiUp.filter((x) => ["winner", "loser", "flat"].includes(x.outcome)).length;
    return { lane, n: xs.length, winners: w, losers: l, flat: f, open: c("open"), noData: c("no-data"), winRate: decided ? Math.round((w / decided) * 1000) / 10 : null, avgT1: avg("t1"), avgT3: avg("t3"), avgMaxGain: avg("maxGainPct"), oiUpNextDay: { n: oiDec, winRate: oiDec ? Math.round((oiWin / oiDec) * 1000) / 10 : null } };
  });
  return rows;
}

/** Win rate by shadow-signal verdict across all logged entries (study only). */
function signalStats(all: Outcome[]) {
  const logged = all.filter((o) => o.kind === "logged" && ["winner", "loser", "flat"].includes(o.outcome));
  const out: Record<string, Record<string, { n: number; winners: number; losers: number; winRate: number | null }>> = {};
  for (const k of ["dp", "gex", "oi", "insider", "netPrem", "flex"] as const) {
    out[k] = {};
    for (const o of logged) {
      const v = o.sig?.[k] ?? "n/a";
      const b = (out[k][v] ??= { n: 0, winners: 0, losers: 0, winRate: null });
      b.n += 1;
      if (o.outcome === "winner") b.winners += 1;
      if (o.outcome === "loser") b.losers += 1;
    }
    for (const b of Object.values(out[k])) b.winRate = b.n ? Math.round((b.winners / b.n) * 1000) / 10 : null;
  }
  return out;
}

function writeDataset(all: Outcome[]) {
  const featKeys = [...new Set(all.flatMap((o) => Object.keys(o.features)))].sort();
  const cols = ["day", "lane", "kind", "contract", "ticker", "side", "expiry", "entry", "printTimeUtc", ...featKeys.map((k) => `f_${k}`), "oiChangeT1Pct", "sig_dp", "sig_gex", "sig_oi", "sig_insider", "sig_netPrem", "sig_flex", "sig_gexRegime", "sig_roomPct", "sig_dpPremiumUsd", "sig_netPremUsd", "sig_insiderBuyUsd", "sig_insiderSellUsd", "sig_flexOi", "t1", "t3", "t5", "maxGainPct", "maxDrawdownPct", "outcome", "final"];
  const esc = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(",")];
  for (const o of all) {
    const rec: Record<string, unknown> = { ...o, ...Object.fromEntries(featKeys.map((k) => [`f_${k}`, o.features[k]])), sig_dp: o.sig?.dp, sig_gex: o.sig?.gex, sig_oi: o.sig?.oi, sig_insider: o.sig?.insider, sig_netPrem: o.sig?.netPrem, sig_flex: o.sig?.flex, sig_gexRegime: o.sig?.gexRegime, sig_roomPct: o.sig?.roomPct, sig_dpPremiumUsd: o.sig?.dpPremiumUsd, sig_netPremUsd: o.sig?.netPremUsd, sig_insiderBuyUsd: o.sig?.insiderBuyUsd, sig_insiderSellUsd: o.sig?.insiderSellUsd, sig_flexOi: o.sig?.flexOi };
    lines.push(cols.map((c) => esc(rec[c])).join(","));
  }
  fs.writeFileSync(p("datasets", "entries.csv"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function finalize(today: string, t0: number, holidays: Set<string>, report: Record<string, unknown>) {
  const all = await scoreAll(today);
  const summary = summarize(all);
  writeDataset(all);
  const days = fs.readdirSync(p("replay")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).sort();
  const flowDays = fs.readdirSync(p("flow")).filter((f) => f.endsWith(".json.gz")).length;
  const doc = {
    generatedAt: new Date().toISOString(),
    coverage: { replayedDays: days.length, from: days[0] ?? null, to: days[days.length - 1] ?? null, flowDays, holidays: holidays.size },
    uw: { tokenCountAtEnd: budget.tokenCountToday, callsThisRun: budget.runCalls, stopAt: STOP_AT, stopped: budget.stopped || null },
    run: { ...report, minutes: Math.round((Date.now() - t0) / 600) / 100 },
    rules: "Current live rules replayed at 10:00/10:30/11:00/12:00/13:00/13:55/15:45 ET. Lanes/puts/picks/premove: winner = option high ≥ +40% before low ≤ −25% within the time stop (lanes per definition, puts/picks/premove 3 sessions); flat otherwise. Lottery: winner = +100% before expiry. Entry = flow print price. Yields/econ calendar unavailable in replay. Study only — not financial advice.",
    lanes: summary,
    shadowSignals: signalStats(all),
  };
  writeJson(p("backtest-summary.json"), doc);
  const md = [
    `# FlowGuard history backtest (study only — not financial advice)`,
    ``,
    `Generated ${doc.generatedAt}. Replayed ${days.length} sessions (${doc.coverage.from} → ${doc.coverage.to}).`,
    ``,
    `| Lane | n | W | L | Flat | Open | No data | Win % (decided) | Avg T+1 | Avg T+3 | Avg max gain | OI↑ next day: n / win % |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`,
    ...summary.map((r) => `| ${r.lane} | ${r.n} | ${r.winners} | ${r.losers} | ${r.flat} | ${r.open} | ${r.noData} | ${r.winRate ?? "—"} | ${r.avgT1 ?? "—"} | ${r.avgT3 ?? "—"} | ${r.avgMaxGain ?? "—"} | ${r.oiUpNextDay.n} / ${r.oiUpNextDay.winRate ?? "—"} |`),
    ``,
    `## Shadow signals (logged entries, decided only)`,
    ``,
    `| Signal | Verdict | n | W | L | Win % |`,
    `|---|---|---:|---:|---:|---:|`,
    ...Object.entries(doc.shadowSignals).flatMap(([k, m]) => Object.entries(m).map(([v, b]) => `| ${k} | ${v} | ${b.n} | ${b.winners} | ${b.losers} | ${b.winRate ?? "—"} |`)),
    ``,
    doc.rules,
  ].join("\n");
  fs.writeFileSync(p("backtest-summary.md"), md);
  writeJson(p("logs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), doc);
}

async function main() {
  ensureDirs();
  const today = etToday();
  const t0 = Date.now();
  const holidays = new Set(readJson<string[]>(holidayFile) ?? []);
  const report = { startedAt: new Date().toISOString(), today, stopAt: STOP_AT, daysFetched: 0, daysReplayed: 0, flowPagesThisRun: 0, stoppedReason: "", errors: [] as string[] };
  log(`history job start (root ${ROOT}, stop at UW count ${STOP_AT})`);

  if (!SUMMARY_ONLY) {
    const BLOCK = Number(args.get("block") || 10);
    const tried = new Set<string>();
    let n = 0;
    while (n < MAX_DAYS && !budget.stopped) {
      const block = candidateDays(today).filter((d) => !tried.has(d) && !holidays.has(d) && !fs.existsSync(replayFile(d))).slice(0, Math.min(BLOCK, MAX_DAYS - n));
      if (!block.length) break;
      const ready: string[] = [];
      for (const day of block) {
        tried.add(day);
        try {
          if (!loadFlowDay(day)) {
            if (NO_FETCH) continue;
            const r = await fetchFlowDay(day);
            report.flowPagesThisRun += r.uwCalls;
            report.daysFetched += 1;
            log(`flow ${day}: ${r.count} prints, ${r.uwCalls} UW calls (token count ${budget.tokenCountToday})`);
            if (r.count < 200) {
              holidays.add(day);
              writeJson(holidayFile, [...holidays].sort());
              continue;
            }
          }
          await fetchTideDay(day);
          ready.push(day);
        } catch (e) {
          if (e instanceof BudgetStop || (e as Error)?.name === "BudgetStop") {
            report.stoppedReason = (e as Error).message;
            break;
          }
          report.errors.push(`${day}: ${(e as Error).message?.slice(0, 200)}`);
          log(`ERROR ${day}:`, (e as Error).message);
        }
      }
      if (ready.length) {
        // Fresh process per block; days replayed oldest → newest so the fake clock only moves forward.
        const code = await new Promise<number>((resolve) => {
          const child = spawn("npx", ["tsx", "--conditions=react-server", "scripts/backtest/replay-block.ts", ...ready], { stdio: "inherit", env: process.env });
          child.on("exit", (c) => resolve(c ?? 1));
        });
        const done = ready.filter((d) => fs.existsSync(replayFile(d)));
        // Score outcomes progressively (newest first) so coverage of outcomes tracks coverage of days.
        if (code !== 3) await finalize(today, t0, holidays, report).catch((e) => log("finalize error", (e as Error).message));
        report.daysReplayed += done.length;
        n += done.length;
        if (code === 3) {
          report.stoppedReason ||= "UW budget stop (replay lookups)";
          budget.stopped ||= report.stoppedReason;
        } else if (code !== 0) {
          report.errors.push(`replay block ${ready[0]}..${ready[ready.length - 1]} exit ${code}`);
          if (report.errors.length > 20) break;
        }
      }
      if (report.errors.length > 20) break;
    }
  }

  await finalize(today, t0, holidays, report);
  log(`done: replayed=${report.daysReplayed} fetched=${report.daysFetched} uwCalls=${budget.runCalls} tokenCount=${budget.tokenCountToday} ${budget.stopped || ""}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("fatal", e?.message ?? e);
    process.exit(1);
  },
);
