/**
 * TEST MODE study: how many flow prints / tickers survive each live filter before the Grok lessons reviewer sees them.
 * Cached history only (no UW calls): history/flow/<day>.json.gz, evaluated at 13:55 ET (the Picks snapshot time).
 * Mirrors lib/flow-service applyFilters (PICKS_FILTERS) + withActionableAdjustments exclusions. Market tide is not
 * replayed here (ticker tides are), so scores can differ by the with/against-tide chip; pool sizes come from history/pools.
 * Usage: npx tsx scripts/study/grok-wide-funnel.ts 2026-10-01 2026-10-16 [out.json]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { PICKS_FILTERS } from "../../lib/filters";
import { toNumber } from "../../lib/numbers";
import { excludedFromActionable, rankAlerts } from "../../lib/scoring";
import { isLateSessionPrint } from "../../lib/session";
import type { FlowAlert } from "../../lib/types";

const H = process.env.HISTORY_DIR ?? "/workspace/flowguard/history";
const [from, to, out] = process.argv.slice(2);

function looksUnusual(a: FlowAlert): boolean {
  if (a.all_opening_trades || a.has_sweep || a.has_floor) return true;
  if (toNumber(a.volume_oi_ratio) >= 1) return true;
  if (a.total_size > 0 && a.open_interest > 0 && a.total_size > a.open_interest) return true;
  const rule = (a.alert_rule || "").trim();
  return rule.length > 0 && rule.toLowerCase() !== "none";
}

function at1355(day: string): Date {
  // 13:55 ET; ET offset from the day itself (EDT before Nov 1 2026, EST after).
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T13:55:00${off}`);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d);
    if (hour === "13") return d;
  }
  return new Date(`${day}T17:55:00Z`);
}

const days = readdirSync(`${H}/flow`).map((f) => f.slice(0, 10)).filter((d) => d >= from && d <= to).sort();
const rows: Record<string, unknown>[] = [];
for (const day of days) {
  const j = JSON.parse(gunzipSync(readFileSync(`${H}/flow/${day}.json.gz`)).toString());
  if (!j.count) continue;
  const now = at1355(day);
  const alerts: FlowAlert[] = j.rows
    .map((r: unknown[]) => Object.fromEntries(j.fields.map((f: string, i: number) => [f, r[i]])) as unknown as FlowAlert)
    .filter((a: FlowAlert) => Date.parse(a.created_at) <= now.getTime());
  const tk = (xs: { ticker: string }[]) => new Set(xs.map((x) => x.ticker)).size;
  const ranked = rankAlerts(alerts, { now });
  const stage = { prints: alerts.length, tickers: tk(alerts) } as Record<string, number>;
  let cur = ranked;
  const step = (name: string, keep: (r: (typeof ranked)[number]) => boolean) => {
    cur = cur.filter(keep);
    stage[`after_${name}`] = cur.length;
  };
  step("dte_0_60", (r) => r.dte >= PICKS_FILTERS.minDte && r.dte <= PICKS_FILTERS.maxDte);
  step("unusual", (r) => looksUnusual(r.alert));
  step("score55", (r) => r.score >= PICKS_FILTERS.minConviction);
  step("anti_fade", (r) => !r.stale && !r.fadeProne);
  step("actionable", (r) => !excludedFromActionable(r));
  step("late_print", (r) => !isLateSessionPrint(r.alert.created_at, now));
  stage.tickers_actionable = tk(cur.map((r) => r.alert));
  stage.contracts_actionable = new Set(cur.map((r) => r.alert.option_chain)).size;
  const pf = `${H}/pools/${day}.json`;
  if (existsSync(pf)) {
    const pools = JSON.parse(readFileSync(pf, "utf8")).pools as { list: string; listCap: number; rows: { capRank: number | null; ticker: string }[] }[];
    for (const p of pools) {
      stage[`pool_${p.list}_stored`] = p.rows.length;
      stage[`pool_${p.list}_shown`] = p.rows.filter((r) => r.capRank != null && r.capRank <= p.listCap).length;
    }
  }
  rows.push({ day, ...stage });
  console.log(day, JSON.stringify(stage));
}
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
