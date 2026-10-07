import "server-only";

import { loadPaperView } from "@/lib/paper";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchContractTradesRaw, fetchNetPremTicks, fetchTickerOptionQuotes, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwJobBudgetOk } from "@/lib/uw-usage";

/**
 * TEST / SHADOW intraday pick monitor ("fade-watch"). Watches every open paper position (AI picks, Premove,
 * Pick-of-the-Day/main, puts, lottery and test lanes) and LOGS an "early fade warning" when follow-through dies.
 * Never closes, alters or re-ranks anything — paper exits, live picks and the AI review are untouched.
 */
const KIND = "fade-watch";
const RECOMPUTE_MS = 3.5 * 60_000;
const MAX_POSITIONS = 30;
export const FADE_RULE =
  "Signals: S1 bid-side takeover = bid-side premium on the contract since entry ≥ $25k and ≥ 60% of ask+bid; S2 mark ≤ entry −10%; S3 ticker tide flip = ticker net (call−put) premium over the last 30 min ≥ $200k against the position. Warning = S2 with S1 or S3, or S1 with S3. Logged only.";
export const FADE_BACKTEST =
  "2-year proxy replay (14,942 candidates, alert-level flow only, market tide for S3): warned 453 → 139W/291L/23F (32.3% win, 64% losers) vs not warned 39.7% win (55% losers). prem−10 + tide flip: 23.6% win (n=171); all three: 16% (n=27). Only 3.5% of losers got a warning in the proxy (sparse alert data) — the live check uses full trades, so expect more.";

export type FadeSignals = { bidTakeover: boolean; premDown10: boolean; tideFlip: boolean };
export type FadeRow = {
  id: string;
  contract: string;
  ticker: string;
  side: "call" | "put";
  source: string;
  book: string;
  enteredAt: string;
  entry: number;
  mark: number | null;
  markSource: string | null;
  pnlPct: number | null;
  askPrem: number;
  bidPrem: number;
  bidShare: number | null;
  tickerNet30m: number | null;
  signals: FadeSignals;
  warning: boolean;
  firstWarningAt: string | null;
  firstWarningPnlPct: number | null;
  firstWarningSignals: string[];
  checks: number;
  lastCheckedAt: string;
};
export type FadeDoc = {
  day: string;
  updatedAt: string;
  rows: Record<string, FadeRow>;
  uwCalls: number;
  note: string | null;
  log: Array<{ at: string; contract: string; event: string; why: string }>;
};

let memo: { at: number; day: string; doc: FadeDoc } | null = null;
let inflight: Promise<FadeDoc> | null = null;

const empty = (day: string): FadeDoc => ({ day, updatedAt: "", rows: {}, uwCalls: 0, note: null, log: [] });
const n = (v: unknown) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

function inRegularHours(now: Date): boolean {
  const c = etClock(now);
  return c.weekday && c.minutes >= 9 * 60 + 30 && c.minutes < 16 * 60;
}

async function compute(now: Date): Promise<FadeDoc> {
  const day = tradingDateET(now);
  const doc = (await loadDoc<FadeDoc>(KIND, day, { fresh: true })) ?? empty(day);
  if (!inRegularHours(now)) return { ...doc, note: "outside regular hours — no checks" };
  if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return { ...doc, note: "UW unavailable — skipped" };
  if (!(await uwJobBudgetOk(150))) return { ...doc, note: "UW daily budget near 35,000 — paused until 8 PM ET reset" };

  return runAsUwJob(KIND, async () => {
    const view = await loadPaperView(now);
    const open = view.open.filter((p) => (p.side === "call" || p.side === "put") && p.contract).slice(0, MAX_POSITIONS);
    let calls = 0;
    const byTicker = new Map<string, typeof open>();
    for (const p of open) byTicker.set(p.ticker, [...(byTicker.get(p.ticker) ?? []), p]);

    // Fresh quotes (batched per ticker, ~3-min cache) + ticker net-prem ticks (5-min cache).
    const quotes: Record<string, { mark: number | null; src: string | null }> = {};
    const tickerNet: Record<string, number | null> = {};
    for (const [ticker, ps] of byTicker) {
      try {
        const r = await fetchTickerOptionQuotes(ticker, ps.map((p) => p.contract), {}, { ttlMs: 180_000 });
        calls += r.calls;
        for (const [sym, q] of Object.entries(r.quotes)) {
          const mark = q ? (q.mid ?? q.last ?? null) : null;
          quotes[sym] = { mark: mark && mark > 0 ? mark : null, src: q ? (q.mid ? "uw_mid" : q.quality) : null };
        }
      } catch {
        /* keep going */
      }
      try {
        calls += 1;
        const ticks = await fetchNetPremTicks(ticker);
        const last = ticks.slice(-30);
        tickerNet[ticker] = last.length ? last.reduce((s, t) => s + n(t.net_call_premium) - n(t.net_put_premium), 0) : null;
      } catch {
        tickerNet[ticker] = null;
      }
    }

    for (const p of open) {
      let askPrem = 0;
      let bidPrem = 0;
      try {
        calls += 1;
        const trades = await fetchContractTradesRaw(p.contract, new Date(p.enteredAt).getTime() / 1000, 150_000);
        for (const t of trades) {
          const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
          const prem = n(t.premium);
          if (tags.includes("ask_side")) askPrem += prem;
          else if (tags.includes("bid_side")) bidPrem += prem;
        }
      } catch {
        /* trades optional */
      }
      const side = p.side as "call" | "put";
      const q = quotes[p.contract] ?? { mark: null, src: null };
      const pnlPct = q.mark != null && p.entryPrice > 0 ? +((q.mark / p.entryPrice - 1) * 100).toFixed(1) : null;
      const bidShare = askPrem + bidPrem > 0 ? +(bidPrem / (askPrem + bidPrem)).toFixed(2) : null;
      const tn = tickerNet[p.ticker] ?? null;
      const signals: FadeSignals = {
        bidTakeover: bidPrem >= 25_000 && (bidShare ?? 0) >= 0.6,
        premDown10: pnlPct != null && pnlPct <= -10,
        tideFlip: tn != null && (side === "call" ? tn <= -200_000 : tn >= 200_000),
      };
      const warning = (signals.premDown10 && (signals.bidTakeover || signals.tideFlip)) || (signals.bidTakeover && signals.tideFlip);
      const prev = doc.rows[p.id];
      const at = now.toISOString();
      const names = Object.entries(signals).filter(([, v]) => v).map(([k]) => k);
      const row: FadeRow = {
        id: p.id,
        contract: p.contract,
        ticker: p.ticker,
        side,
        source: p.source,
        book: p.book,
        enteredAt: p.enteredAt,
        entry: p.entryPrice,
        mark: q.mark,
        markSource: q.src,
        pnlPct,
        askPrem: Math.round(askPrem),
        bidPrem: Math.round(bidPrem),
        bidShare,
        tickerNet30m: tn != null ? Math.round(tn) : null,
        signals,
        warning,
        firstWarningAt: prev?.firstWarningAt ?? (warning ? at : null),
        firstWarningPnlPct: prev?.firstWarningAt ? prev.firstWarningPnlPct : warning ? pnlPct : null,
        firstWarningSignals: prev?.firstWarningAt ? prev.firstWarningSignals : warning ? names : [],
        checks: (prev?.checks ?? 0) + 1,
        lastCheckedAt: at,
      };
      if (warning && !prev?.firstWarningAt) doc.log.push({ at, contract: p.contract, event: "early-fade-warning", why: names.join("+") });
      if (prev?.warning && !warning) doc.log.push({ at, contract: p.contract, event: "warning-cleared", why: names.join("+") || "none" });
      doc.rows[p.id] = row;
    }
    const next: FadeDoc = { ...doc, updatedAt: now.toISOString(), uwCalls: doc.uwCalls + calls, note: null, log: doc.log.slice(-400) };
    await saveDoc(KIND, day, next);
    return next;
  });
}

export async function loadFadeWatch(opts: { day?: string; now?: Date; refresh?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const today = tradingDateET(now);
  const wrap = (doc: FadeDoc) => ({
    mode: "test" as const,
    disclaimer: "TEST / SHADOW — early fade warnings are logged only; paper exits, live picks and the AI review are untouched. Not financial advice.",
    persistence: persistenceMode(),
    rule: FADE_RULE,
    backtest: FADE_BACKTEST,
    warnings: Object.values(doc.rows).filter((r) => r.firstWarningAt).length,
    ...doc,
  });
  if (opts.day && opts.day !== today) return wrap((await loadDoc<FadeDoc>(KIND, opts.day)) ?? empty(opts.day));
  if (!opts.refresh || (memo && memo.day === today && now.getTime() - memo.at < RECOMPUTE_MS)) {
    if (memo && memo.day === today) return wrap(memo.doc);
    if (!opts.refresh) return wrap((await loadDoc<FadeDoc>(KIND, today)) ?? empty(today));
  }
  if (!inflight) {
    inflight = compute(now)
      .then((doc) => {
        memo = { at: Date.now(), day: today, doc };
        return doc;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return wrap(await inflight);
}
