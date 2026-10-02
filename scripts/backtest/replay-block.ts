/**
 * Child process for nightly.ts: replays a block of days in ASCENDING order in one fresh module graph, so the
 * fake clock only moves forward (app caches compare Date.now() deltas) and books carry across the block like live.
 * Exit code 3 = UW budget stop.
 */
import { BudgetStop } from "./uw-budget";
import { ensureDirs, fetchTideDay, loadFlowDay, p, writeJson } from "./store";
import { replayDay } from "./replay";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function main() {
  ensureDirs();
  const days = process.argv.slice(2).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const day of days) {
    const alerts = loadFlowDay(day);
    if (!alerts) continue;
    const tide = await fetchTideDay(day);
    const rep = await replayDay(day, alerts, tide);
    const { pools, ...rest } = rep;
    if (pools) writeJson(p("pools", `${day}.json`), pools);
    writeJson(p("replay", `${day}.json`), rest);
    const counts = rep.entries.reduce<Record<string, number>>((m, e) => ((m[e.lane] = (m[e.lane] ?? 0) + 1), m), {});
    log(`replay ${day}: ${rep.entries.length} entries in ${(rep.ms / 1000).toFixed(1)}s ${JSON.stringify(counts)}${Object.keys(rep.unhandled).length ? ` unhandled=${JSON.stringify(rep.unhandled)}` : ""}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    if (e instanceof BudgetStop || e?.name === "BudgetStop") {
      log(`replay block: ${e.message}`);
      process.exit(3);
    }
    console.error("replay block fatal", e?.stack ?? e);
    process.exit(1);
  },
);
