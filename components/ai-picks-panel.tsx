"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiPicksResponse } from "@/lib/types";
import { formatDte, formatExpiry, formatStrike } from "@/lib/format";

const POLL_MS = 15 * 60_000;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function AiPicksPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const [data, setData] = useState<AiPicksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (rerun = false) => {
    setLoading(true);
    try {
      const response = await fetch(rerun ? "/api/ai-picks?rerun=1" : "/api/ai-picks", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as AiPicksResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(false), 0);
    const id = window.setInterval(() => void load(false), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const picks = data?.picks ?? [];
  const engineLabel =
    data?.engine === "llm"
      ? `AI · ${data.llmModel ?? "LLM"}`
      : data?.llmStatus === "no-key"
        ? "Rules fallback · LLM_API_KEY not set"
        : data?.llmStatus === "error" || data?.llmStatus === "invalid-output"
          ? "Rules fallback · LLM unavailable"
          : data?.llmStatus === "throttled"
            ? "Rules · AI review queued"
            : "Rules";

  return (
    <section className="rounded-xl border border-violet-400/25 bg-gradient-to-b from-violet-950/30 to-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-violet-300" />
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200/80">
              Manager · AI picks
            </span>
          </div>
          <h2 className="mt-1 font-medium">Final 3–5 after regime, caps, and AI review</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Top actionable candidates (morning first) reviewed against the macro regime and the desk&apos;s
            recent study-book outcomes. Each pick carries an exit plan on option premium. Options-flow
            context only, not financial advice.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="rounded-md bg-violet-500/15 text-violet-200">{engineLabel}</Badge>
          {data?.regime ? (
            <Badge className="rounded-md bg-violet-500/15 text-violet-200">{data.regime.label}</Badge>
          ) : null}
          <Button variant="outline" size="icon-sm" onClick={() => void load(true)} disabled={loading} aria-label="Re-run AI review">
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {error && !data ? <p className="text-sm text-rose-300">AI picks unavailable ({error}).</p> : null}
      {loading && !data ? <p className="text-sm text-muted-foreground">Reviewing candidates…</p> : null}
      {data?.llmCachedAt ? (
        <p className="mb-2 text-xs text-muted-foreground">
          AI review from{" "}
          {new Date(data.llmCachedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          {data.candidatesChanged && data.nextLlmAt
            ? ` · candidates changed, next review after ${new Date(data.nextLlmAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""}
        </p>
      ) : null}
      {data && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data.warning ?? "No picks right now."}</p>
      ) : null}

      {picks.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {picks.map((pick) => (
            <article
              key={pick.alert.id}
              className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3"
              onClick={() => onSelect(pick.alert.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-sm font-semibold">
                  {pick.alert.ticker} {formatStrike(pick.alert.strike)}
                  {pick.alert.type === "call" ? "C" : "P"} {formatExpiry(pick.alert.expiry)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{formatDte(pick.dte)}</span>
                </div>
                <Badge
                  className={cn(
                    "rounded-md",
                    pick.confidence >= 70 ? "bg-emerald-500/15 text-emerald-200" : "bg-zinc-500/15 text-zinc-200",
                  )}
                >
                  {pick.confidence}% conf
                </Badge>
              </div>
              <p className="text-sm leading-relaxed">{pick.aiReason}</p>
              <div className="grid grid-cols-4 gap-2 font-mono text-[11px]">
                <div>
                  <div className="text-muted-foreground">Entry</div>
                  {money(pick.exitPlan.entry)}
                </div>
                <div>
                  <div className="text-emerald-300/80">Target +{pick.exitPlan.targetPct}%</div>
                  {money(pick.exitPlan.target)}
                </div>
                <div>
                  <div className="text-rose-300/80">Stop {pick.exitPlan.stopPct}%</div>
                  {money(pick.exitPlan.stop)}
                </div>
                <div>
                  <div className="text-muted-foreground">Time stop</div>
                  {pick.exitPlan.timeStop.date}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Lanes: {pick.lanes.join(" + ")} · score {pick.score} · {pick.exitPlan.timeStop.rule}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {data && data.skips.length > 0 ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Skipped ({data.skips.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {data.skips.map((s) => (
              <li key={s.option_chain}>
                <span className="font-mono">{s.option_chain}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {data?.study ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Study book {data.study.since}→{data.study.through}: {data.study.totals.w}W / {data.study.totals.l}L /{" "}
          {data.study.totals.flat} flat.
        </p>
      ) : null}
    </section>
  );
}
