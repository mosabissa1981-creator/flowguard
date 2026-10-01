"use client";

import { useCallback, useEffect, useState } from "react";
import { TrendingDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatExpiry, formatPremium, formatStrike } from "@/lib/format";

const POLL_MS = 15 * 60_000;

type PutRow = {
  contract: string;
  ticker: string;
  strike: number;
  expiry: string;
  dte: number;
  price: number;
  entry?: number;
  moneynessPct: number;
  askSharePct: number;
  volOi: number;
  premiumUsd: number;
  putsScore: number;
  confirmations: string[];
  penalties: string[];
  reasons: string[];
  exitPlan?: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; timeStopSessions: number };
};
type PutsView = {
  picks: PutRow[];
  candidates?: PutRow[];
  candidatesConsidered: number;
  context?: { marketTide: string | null; spyPct: number | null; qqqPct: number | null; regimeLabel: string | null; us30yChangeBp: number | null };
  warning?: string;
  disclaimer?: string;
  error?: string;
};

const CONF: Record<string, string> = {
  "market-tide-bearish": "Mkt tide ↓",
  "ticker-tide-bearish": "Ticker tide ↓",
  "risky-yields-rising": "Risky + yields ↑",
  "relative-weakness": "Rel. weak",
};

function money(n: number | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

export function PutsPanel() {
  const [data, setData] = useState<PutsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/puts", { cache: "no-store" });
      const json = (await r.json()) as PutsView;
      if (!r.ok) throw new Error(json?.error ?? `HTTP ${r.status}`);
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const picks = Array.isArray(data?.picks) ? data.picks : [];
  const ctx = data?.context;

  return (
    <section className="rounded-xl border border-dashed border-rose-400/30 bg-card/50 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingDown className="size-4 text-rose-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-rose-200/80">Puts · test mode</span>
        </div>
        <Badge className="rounded-md bg-rose-500/15 text-rose-200">max 3/day · 1/issuer · 2/sector</Badge>
      </div>
      <p className="mb-2 rounded-md bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-100">
        Study only, small size. Logged separately; never in picks or the AI review.
      </p>
      <p className="mb-2 text-xs text-muted-foreground">
        Near-the-money single-leg puts (7–30 DTE) with ask-side opening sweeps, logged only with a risk-off confirmation:
        bearish tide, risky day with rising long yields, or weakness vs SPY/QQQ. Exit: +40% target, −25% stop, 3 sessions.
      </p>
      {ctx ? (
        <p className="mb-2 font-mono text-[10px] text-muted-foreground">
          Tide {ctx.marketTide ?? "—"} · SPY {ctx.spyPct ?? "—"}% · QQQ {ctx.qqqPct ?? "—"}% · {ctx.regimeLabel ?? "regime —"}
          {ctx.us30yChangeBp != null ? ` · 30Y ${ctx.us30yChangeBp > 0 ? "+" : ""}${ctx.us30yChangeBp}bp` : ""}
        </p>
      ) : null}

      {loading && !data ? <p className="text-sm text-muted-foreground">Scanning put flow…</p> : null}
      {error && !data ? <p className="text-sm text-rose-300">Puts lane unavailable ({error}).</p> : null}
      {data && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data.warning ?? "No test puts today."}</p>
      ) : null}

      {picks.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-3">
          {picks.map((p) => (
            <article key={p.contract} className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 font-mono text-sm font-semibold">
                  {p.ticker} {formatStrike(p.strike)}P {formatExpiry(p.expiry)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{p.dte}d</span>
                </div>
                <Badge className="shrink-0 rounded-md bg-rose-500/15 text-rose-200">score {p.putsScore}</Badge>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {p.moneynessPct}% OTM · {p.askSharePct}% ask · vol/OI {p.volOi}× · {formatPremium(p.premiumUsd)}
              </div>
              <div className="flex flex-wrap gap-1">
                {(p.confirmations ?? []).map((c) => (
                  <span key={c} className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-100">
                    {CONF[c] ?? c}
                  </span>
                ))}
                {(p.penalties ?? []).map((c) => (
                  <span key={c} className="rounded bg-zinc-500/20 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    − {c}
                  </span>
                ))}
              </div>
              {p.exitPlan ? (
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
                  <div>
                    <div className="text-muted-foreground">Entry</div>
                    {money(p.entry ?? p.exitPlan.entry)}
                  </div>
                  <div>
                    <div className="text-emerald-300/80">Target +{p.exitPlan.targetPct}%</div>
                    {money(p.exitPlan.target)}
                  </div>
                  <div>
                    <div className="text-rose-300/80">Stop {p.exitPlan.stopPct}%</div>
                    {money(p.exitPlan.stop)}
                  </div>
                  <div>
                    <div className="text-muted-foreground">Time stop</div>
                    {p.exitPlan.timeStopSessions} sessions
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {data ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {data.candidatesConsidered} eligible put prints on today&apos;s tape · {data.disclaimer ?? "Study only."}
        </p>
      ) : null}
    </section>
  );
}
