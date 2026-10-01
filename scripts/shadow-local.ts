/**
 * Local end-to-end shadow run on a stored morning board (no Vercel, no Blob).
 * Usage (from repo root):
 *   SHADOW_LOCAL_DIR=/tmp/shadow-local npx tsx --conditions=react-server scripts/shadow-local.ts \
 *     /path/to/study 2026-09-30 [HH:MM ET, default 09:52]
 * Needs LLM_API_KEY (xAI) for the LLM modules and UNUSUAL_WHALES_API_KEY for UW-backed modules; both optional.
 * Note: news/X search runs NOW, so "as of" is enforced only by the prompt — expect some look-ahead.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyConcentrationCaps } from "@/lib/issuers";
import { compareActionable, contractKey } from "@/lib/scoring";
import { loadRegime } from "@/lib/regime";
import { runShadow, publicView } from "@/lib/shadow";
import { loadBrief, briefLine } from "@/lib/shadow/brief";
import { loadReleaseReads } from "@/lib/shadow/release-read";
import type { DailyPick, RegimeSnapshot } from "@/lib/types";

async function main() {
  const [studyDir = "study", day = "2026-09-30", hhmm = "09:52"] = process.argv.slice(2);
  if (!process.env.SHADOW_LOCAL_DIR) throw new Error("set SHADOW_LOCAL_DIR");
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const now = new Date(`${day}T${hhmm}:00-04:00`);
  const read = (f: string) => (existsSync(path.join(studyDir, f)) ? JSON.parse(readFileSync(path.join(studyDir, f), "utf8")) : null);
  const board = read(`raw-morning-board-${day}.json`);
  const premove = read(`raw-morning-premove-${day}.json`);
  const byKey = new Map<string, DailyPick & { lanes: string[] }>();
  const add = (rows: DailyPick[] = [], lane: string) => {
    for (const r of rows) {
      const k = contractKey(r);
      const cur = byKey.get(k);
      if (cur) {
        if (!cur.lanes.includes(lane)) cur.lanes.push(lane);
      } else byKey.set(k, { ...r, lanes: [lane] });
    }
  };
  add(board?.picks, "morning");
  add(premove?.picks, "premove");
  const sorted = [...byKey.values()].sort((a, b) => {
    const ma = a.lanes.includes("morning") ? 0 : 1;
    const mb = b.lanes.includes("morning") ? 0 : 1;
    return ma !== mb ? ma - mb : compareActionable(a, b);
  });
  const { kept } = applyConcentrationCaps(sorted, 8);

  let regime: RegimeSnapshot | null = null;
  try {
    regime = await loadRegime();
    if (regime.tradingDate !== day) console.warn(`regime is for ${regime.tradingDate}, not ${day}`);
    if (board?.tide) regime = { ...regime, tide: board.tide };
  } catch (e) {
    console.warn("regime unavailable", e);
  }

  const t0 = Date.now();
  const brief = await loadBrief({ generate: true, now, regime, force: true });
  const reads = await loadReleaseReads({ generate: true, now: new Date(Math.max(now.getTime(), Date.parse(`${day}T10:30:00-04:00`))), regime });
  const doc = await runShadow({ cands: kept, regime, now, force: true, briefLine: briefLine(brief) });
  const second = await runShadow({ cands: kept, regime, now: new Date(now.getTime() + 60_000) });
  const out = { brief, releaseReads: reads, shadow: publicView(doc, true), secondRunLlmStatus: second.llm.status, secondRunUsageCount: second.llm.usage.length, ms: Date.now() - t0 };
  const file = path.join(process.env.SHADOW_LOCAL_DIR, `local-run-${day}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\n=== Shadow ${day} as of ${hhmm} ET — ${doc.candidates.length} finalists, regime ${doc.regime?.label} (${doc.regime?.calendarType}, tide ${doc.regime?.tide})`);
  for (const c of doc.candidates) {
    console.log(`\n${c.contract}  ${c.ticker} ${c.strike}${c.side[0].toUpperCase()} ${c.expiry} dte=${c.dte} score=${c.rawScore} lanes=${c.lanes.join("+")}`);
    for (const v of doc.verdicts[c.contract] ?? []) console.log(`  ${v.module.padEnd(20)} ${v.verdict.padEnd(5)} c=${String(v.confidence).padStart(3)}  ${v.reason}`);
  }
  console.log(`\nregime_analogs: ${(doc.dayNotes.regime_analogs as { note?: string } | undefined)?.note}`);
  console.log(`\nBrief [${brief.status}]: ${brief.brief?.summary ?? brief.error}`);
  for (const r of reads.reads) console.log(`Release read [${r.status}] ${r.event}: ${r.read?.temperature} — ${r.read?.headline ?? r.error}`);
  if (!reads.reads.length) console.log(`Release reads: none due (pending: ${reads.pending.join("; ") || "none"})`);
  console.log("\n=== LLM usage");
  const all = [...doc.llm.usage, ...(brief.usage ? [brief.usage] : []), ...reads.reads.flatMap((r) => (r.usage ? [r.usage] : []))];
  for (const u of all) {
    console.log(`  ${u.module.padEnd(32)} ${u.model.padEnd(10)} in=${u.inputTokens} (cached ${u.cachedTokens}) out=${u.outputTokens} (reasoning ${u.reasoningTokens}) web=${u.webSearchCalls} xCalls=${u.xSearchCalls} xPosts=${u.xPostsFetched} $${u.costUsd.toFixed(4)} [${u.costSource}] ${Math.round(u.ms / 1000)}s`);
  }
  console.log(`  TOTAL $${all.reduce((s, u) => s + u.costUsd, 0).toFixed(4)}`);
  console.log(`UW calls (shadow cache misses): ${doc.uwCalls}; second run LLM status: ${second.llm.status} (usage records ${second.llm.usage.length})`);
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
