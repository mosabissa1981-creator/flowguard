import { alertMs, alertNums } from "@/lib/alert-time";
import type { ChainFadeSignal } from "@/lib/chain-context";
import { followThroughFromCounts, FOLLOW_THROUGH_UP_PCT, type FollowThroughSignal } from "@/lib/follow-through";
import { askShare, toNumber } from "@/lib/numbers";
import { hoursSinceCreated } from "@/lib/session";
import type { FlowAlert } from "@/lib/types";

/**
 * O(n log n) replacement for the per-alert peer scans (later-print fade + follow-through) on large same
 * ticker+side groups of the full-session tape (SPY/QQQ can carry thousands of prints a day).
 * Same rules as fadeFromLaterPrints / followThroughFromPeers; only the example quoted in the detail text can
 * differ (it quotes the extreme later print instead of the first one found).
 */
export function precomputePeerSignals(
  group: FlowAlert[],
  now: Date,
): Map<string, { fade: ChainFadeSignal; follow: FollowThroughSignal }> {
  const rows = group
    .map((a) => ({ a, ts: alertMs(a), n: alertNums(a, askShare, toNumber) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((x, y) => x.ts - y.ts);
  const len = rows.length;
  // Group-level suffix count of ask hits strictly later than each timestamp.
  const askHit = rows.map((r) => r.n.askShare >= 0.55 && r.n.premium >= 10_000);
  const suffixAsk = new Array<number>(len + 1).fill(0);
  for (let i = len - 1; i >= 0; i -= 1) suffixAsk[i] = suffixAsk[i + 1] + (askHit[i] ? 1 : 0);
  // First index with ts > rows[i].ts (ties are not "later").
  const firstLater = new Array<number>(len);
  for (let i = len - 1, j = len; i >= 0; i -= 1) {
    if (i + 1 < len && rows[i + 1].ts > rows[i].ts) j = i + 1;
    firstLater[i] = j;
  }
  // Per-chain suffix stats (indices within the chain's own time-sorted list).
  const byChain = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const c = r.a.option_chain;
    if (!c) return;
    const list = byChain.get(c);
    if (list) list.push(i);
    else byChain.set(c, [i]);
  });
  type ChainStats = { idx: number[]; sufAsk: number[]; sufMax: number[]; sufMin: number[]; sufDump: number[] };
  const stats = new Map<string, ChainStats>();
  for (const [c, idx] of byChain) {
    const m = idx.length;
    const sufAsk = new Array<number>(m + 1).fill(0);
    const sufMax = new Array<number>(m + 1).fill(0);
    const sufMin = new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY);
    const sufDump = new Array<number>(m + 1).fill(-1); // index (in rows) of a later bid-side dump, -1 none
    for (let k = m - 1; k >= 0; k -= 1) {
      const r = rows[idx[k]];
      const px = r.n.price;
      sufAsk[k] = sufAsk[k + 1] + (askHit[idx[k]] ? 1 : 0);
      sufMax[k] = Math.max(sufMax[k + 1], px > 0 ? px : 0);
      sufMin[k] = Math.min(sufMin[k + 1], px > 0 ? px : Number.POSITIVE_INFINITY);
      sufDump[k] = r.n.askShare < 0.4 && r.n.premium >= 10_000 ? idx[k] : sufDump[k + 1];
    }
    stats.set(c, { idx, sufAsk, sufMax, sufMin, sufDump });
  }
  const out = new Map<string, { fade: ChainFadeSignal; follow: FollowThroughSignal }>();
  const chainPos = new Map<number, number>();
  for (const [, s] of stats) s.idx.forEach((ri, k) => chainPos.set(ri, k));
  for (let i = 0; i < len; i += 1) {
    const { a, n } = rows[i];
    const alertPx = n.price;
    // Later = rows from firstLater[i]; within chain, first chain position whose row index ≥ firstLater[i].
    let laterAsk = suffixAsk[firstLater[i]];
    let chainHits = 0;
    let upPx: number | null = null;
    let fade: ChainFadeSignal = { faded: false, detail: "" };
    const s = a.option_chain ? stats.get(a.option_chain) : undefined;
    if (s) {
      let k = chainPos.get(i) ?? 0;
      while (k < s.idx.length && s.idx[k] < firstLater[i]) k += 1;
      chainHits = s.sufAsk[k];
      if (alertPx > 0 && s.sufMax[k] >= alertPx * (1 + FOLLOW_THROUGH_UP_PCT)) upPx = s.sufMax[k];
      if (alertPx > 0 && s.sufMin[k] <= alertPx * 0.85) {
        const px = s.sufMin[k];
        fade = { faded: true, detail: `Later print on ${a.option_chain} at $${px.toFixed(2)} is ${Math.round((1 - px / alertPx) * 100)}% below the alert ($${alertPx.toFixed(2)}).` };
      } else if (s.sufDump[k] >= 0) {
        const d = rows[s.sufDump[k]].n;
        fade = { faded: true, detail: `Later bid-side selling on ${a.option_chain} after the alert (${Math.round((1 - d.askShare) * 100)}% bid-side premium).` };
      }
    }
    // followThroughFromPeers excludes the alert itself; it is never "later" than itself, so no correction needed.
    if (laterAsk < 0) laterAsk = 0;
    out.set(a.id, { fade, follow: followThroughFromCounts(a, laterAsk, chainHits, upPx, hoursSinceCreated(a.created_at, now)) });
  }
  return out;
}
