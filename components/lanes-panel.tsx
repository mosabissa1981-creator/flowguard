"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatExpiry, formatPremium, formatStrike } from "@/lib/format";

const POLL_MS = 15 * 60_000;

type Row = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  price: number;
  entry?: number;
  otmPct: number;
  askSharePct: number;
  volOi: number;
  premiumUsd: number;
  laneScore: number;
  reasons: string[];
  exitPlan?: { target: number; targetPct: number; stop: number; stopPct: number; timeStopSessions: number };
};
type Lane = {
  lane: { id: string; title: string; side: "call" | "put"; maxPerDay: number; rules: string };
  picks: Row[];
  candidatesConsidered: number;
  warning?: string;
};
type View = {
  lanes: Lane[];
  context?: { marketTide: string | null; spyPct: number | null; qqqPct: number | null; regimeLabel: string | null };
  disclaimer?: string;
  error?: string;
};

function money(n: number | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

export function LanesPanel() {
  const [data, setData] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/lanes", { cache: "no-store" });
      const json = (await r.json()) as View;
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

  const lanes = Array.isArray(data?.lanes) ? data.lanes.filter((l) => l?.lane?.id) : [];
  const active = lanes.find((l) => l.lane.id === tab) ?? lanes.find((l) => (l.picks ?? []).length > 0) ?? lanes[0];
  const picks = Array.isArray(active?.picks) ? active.picks : [];
  const ctx = data?.context;

  return (
    <section className="rounded-xl border border-dashed border-sky-400/30 bg-card/50 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-sky-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-200/80">Setup lanes · test mode</span>
        </div>
        {ctx ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            Tide {ctx.marketTide ?? "—"} · SPY {ctx.spyPct ?? "—"}% · QQQ {ctx.qqqPct ?? "—"}% · {ctx.regimeLabel ?? "—"}
          </span>
        ) : null}
      </div>
      <p className="mb-2 rounded-md bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-100">
        Study only, small size. Six rule lanes logged separately; never in picks or the AI review.
      </p>

      {loading && !data ? <p className="text-sm text-muted-foreground">Scanning setup lanes…</p> : null}
      {error && !data ? <p className="text-sm text-rose-300">Setup lanes unavailable ({error}).</p> : null}

      {lanes.length > 0 ? (
        <>
          <div className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist">
            {lanes.map((l) => (
              <button
                key={l.lane.id}
                type="button"
                role="tab"
                aria-selected={active?.lane.id === l.lane.id}
                onClick={() => setTab(l.lane.id)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md border px-2 py-1 text-[11px]",
                  active?.lane.id === l.lane.id ? "border-sky-400/50 bg-sky-500/15 text-sky-100" : "border-border/70 text-muted-foreground",
                  l.lane.side === "put" && active?.lane.id !== l.lane.id && "text-rose-200/70",
                )}
              >
                {l.lane.title.replace(/^(Calls|Puts) · /, l.lane.side === "call" ? "C · " : "P · ")}
                <span className="ml-1 font-mono">{(l.picks ?? []).length}</span>
              </button>
            ))}
          </div>
          {active ? (
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{active.lane.title}.</span> {active.lane.rules} Max {active.lane.maxPerDay}/day, 1 per
                issuer. Exit +40% / −25%.
              </p>
              {picks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {active.warning ?? "No setups today."} ({active.candidatesConsidered} candidates)
                </p>
              ) : (
                <div className="grid gap-2 lg:grid-cols-3">
                  {picks.map((p) => (
                    <article key={p.contract} className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 font-mono text-sm font-semibold">
                          {p.ticker} {formatStrike(p.strike)}
                          {p.side === "call" ? "C" : "P"} {formatExpiry(p.expiry)}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">{p.dte}d</span>
                        </div>
                        <Badge className="shrink-0 rounded-md bg-sky-500/15 text-sky-200">score {p.laneScore}</Badge>
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {p.otmPct}% OTM · {p.askSharePct}% ask · vol/OI {p.volOi}× · {formatPremium(p.premiumUsd)}
                      </div>
                      <p className="break-words text-xs leading-relaxed">{(p.reasons ?? []).join(" · ")}</p>
                      {p.exitPlan ? (
                        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
                          <div>
                            <div className="text-muted-foreground">Entry</div>
                            {money(p.entry ?? p.price)}
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
              )}
            </div>
          ) : null}
        </>
      ) : null}
      {data ? <p className="mt-2 text-[10px] text-muted-foreground">{data.disclaimer ?? "Study only."}</p> : null}
    </section>
  );
}
