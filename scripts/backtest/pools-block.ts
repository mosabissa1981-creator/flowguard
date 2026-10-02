/**
 * Child process: Picks/Premove candidate pools for already-replayed days (ascending, fresh module graph).
 * Uses only cached flow/tide/ohlc/earnings; any missing lookup goes through the budgeted UW client
 * (or fails the day under UW_OFFLINE=1). Exit code 3 = UW budget stop.
 */
import fs from "node:fs";

import { BudgetStop } from "./uw-budget";
import { ensureDirs, fetchTideDay, loadFlowDay, p, writeJson } from "./store";
import { replayPoolsDay } from "./replay";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function main() {
  ensureDirs();
  const days = process.argv.slice(2).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let failed = 0;
  for (const day of days) {
    const out = p("pools", `${day}.json`);
    if (fs.existsSync(out)) continue;
    const alerts = loadFlowDay(day);
    if (!alerts) continue;
    try {
      const tide = await fetchTideDay(day);
      const r = await replayPoolsDay(day, alerts, tide);
      writeJson(out, r);
      log(`pools ${day}: ${r.pools.map((x) => `${x.list} ${x.rows.length}${x.locked ? " (locked)" : ""}`).join(", ")} check=${JSON.stringify(r.check)} ${(r.ms / 1000).toFixed(1)}s`);
    } catch (e) {
      if (e instanceof BudgetStop || (e as Error)?.name === "BudgetStop") {
        if (process.env.UW_OFFLINE === "1") {
          failed += 1;
          log(`pools ${day}: skipped (needs an uncached UW lookup; retry after the reset)`);
          continue;
        }
        throw e;
      }
      failed += 1;
      log(`pools ${day}: ERROR ${(e as Error).message?.slice(0, 200)}`);
    }
  }
  if (failed) log(`pools block: ${failed} day(s) not done`);
}

main().then(
  () => process.exit(0),
  (e) => {
    if (e instanceof BudgetStop || e?.name === "BudgetStop") {
      log(`pools block: ${e.message}`);
      process.exit(3);
    }
    console.error("pools block fatal", e?.stack ?? e);
    process.exit(1);
  },
);
