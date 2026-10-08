"use client";

import { useCallback, useEffect, useState } from "react";
import { Ticket } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SpreadBadge } from "@/components/spread-gate";
import type { SpreadInfo } from "@/lib/spread-core";
import { formatExpiry, formatStrike } from "@/lib/format";

const POLL_MS = 15 * 60_000;

type Catalyst = { kind: "earnings" | "macro"; date: string; label: string } | null;
type LotteryRow = {
  spread?: SpreadInfo;
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
  lotteryScore: number;
  catalyst: Catalyst;
  reasons: string[];
};
type LotteryView = {
  day: string;
  picks: LotteryRow[];
  candidatesConsidered: number;
  warning?: string;
  disclaimer?: string;
  error?: string;
};

export function LotteryPanel() {
  const [data, setData] = useState<LotteryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/lottery", { cache: "no-store" });
      const json = (await r.json()) as LotteryView;
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

  return (
    <section className="rounded-xl border border-dashed border-fuchsia-400/30 bg-card/50 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Ticket className="size-4 text-fuchsia-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-fuchsia-200/80">
            Lottery · test mode
          </span>
        </div>
        <Badge className="rounded-md bg-fuchsia-500/15 text-fuchsia-200">max 3/day · 1 per issuer</Badge>
      </div>
      <p className="mb-2 rounded-md bg-fuchsia-500/10 px-2 py-1 text-xs font-medium text-fuchsia-100">
        Tiny size, expect most to expire worthless, study only.
      </p>
      <p className="mb-2 text-xs text-muted-foreground">
        Cheap OTM ($0.05–1.00, 5–30 DTE) with heavy ask-side sweeps and vol ≫ OI on liquid names, catalyst before
        expiry preferred. Logged for the study book; never in picks or the AI review.
      </p>

      {loading && !data ? <p className="text-sm text-muted-foreground">Scanning the tape for lottery tickets…</p> : null}
      {error && !data ? <p className="text-sm text-rose-300">Lottery lane unavailable ({error}).</p> : null}
      {data && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data.warning ?? "No lottery tickets today."}</p>
      ) : null}

      {picks.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-3">
          {picks.map((p) => (
            <article key={p.contract} className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 font-mono text-sm font-semibold">
                  {p.ticker} {formatStrike(p.strike)}
                  {p.side === "call" ? "C" : "P"} {formatExpiry(p.expiry)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{p.dte}d</span>
                </div>
                <Badge className="shrink-0 rounded-md bg-fuchsia-500/15 text-fuchsia-200">
                  ${Number(p.entry ?? p.price ?? 0).toFixed(2)}
                </Badge>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {p.otmPct}% OTM · {p.askSharePct}% ask · vol/OI {p.volOi}× · score {p.lotteryScore} <SpreadBadge spread={p.spread} testOnly />
              </div>
              {p.catalyst ? (
                <div className="text-[11px] text-amber-200">
                  Catalyst: {p.catalyst.label} {p.catalyst.date}
                </div>
              ) : null}
              <p className="break-words text-xs leading-relaxed">{(p.reasons ?? []).join(" · ")}</p>
              <div className="font-mono text-[10px] text-muted-foreground">
                Study: +100% ${(Number(p.entry ?? p.price) * 2).toFixed(2)} · +300% ${(Number(p.entry ?? p.price) * 4).toFixed(2)} · +1000%{" "}
                ${(Number(p.entry ?? p.price) * 11).toFixed(2)}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {data ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {data.candidatesConsidered} eligible on today&apos;s tape · {data.disclaimer ?? "Study only."}
        </p>
      ) : null}
    </section>
  );
}
