"use client";

import { Bot } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AiPicksResponse } from "@/lib/types";
import { formatDte, formatExpiry, formatStrike } from "@/lib/format";

function money(n: number): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

/** AI take/skip review of the Premove ("Before the move") lane; data comes from /api/ai-picks (same LLM call). */
export function PremoveAiPanel({
  data,
  loading,
  error,
  onSelect,
}: {
  data: AiPicksResponse | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
}) {
  const review = data?.premove;
  const picks = Array.isArray(review?.picks) ? review.picks.filter((p) => p?.alert && p.exitPlan) : [];
  const skips = Array.isArray(review?.skips) ? review.skips : [];
  const engine =
    data?.engine === "llm" && review && !review.warning?.startsWith("AI returned no premove")
      ? `AI · ${data.llmModel ?? "LLM"}`
      : "Rules";

  return (
    <section className="rounded-xl border border-violet-400/20 bg-card/60 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-violet-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200/80">
            Premove · AI review
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className="rounded-md bg-violet-500/15 text-violet-200">{engine}</Badge>
          {review ? (
            <Badge className="rounded-md bg-violet-500/15 text-violet-200">
              take ≤{review.maxPicks} of {review.candidatesConsidered}
            </Badge>
          ) : null}
        </div>
      </div>

      {loading && !data ? <p className="text-sm text-muted-foreground">Reviewing premove candidates…</p> : null}
      {error && !data ? <p className="text-sm text-rose-300">Premove AI review unavailable ({error}).</p> : null}
      {data && !review ? (
        <p className="text-sm text-muted-foreground">Premove review starts with the next AI run.</p>
      ) : null}
      {data?.candidatesChanged && data.nextLlmAt ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Candidates changed · next AI review after{" "}
          {new Date(data.nextLlmAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </p>
      ) : null}
      {review && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{review.warning ?? "No premove takes right now."}</p>
      ) : null}
      {review?.warning && picks.length > 0 ? <p className="mb-2 text-xs text-amber-300">{review.warning}</p> : null}

      {picks.length > 0 ? (
        <div className="grid gap-2 lg:grid-cols-2">
          {picks.map((pick) => (
            <article
              key={pick.alert.id}
              className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3"
              onClick={() => onSelect(pick.alert.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 font-mono text-sm font-semibold">
                  <span className="mr-1.5 rounded bg-emerald-500/20 px-1 text-[10px] font-medium text-emerald-200">TAKE</span>
                  {pick.alert.ticker} {formatStrike(pick.alert.strike)}
                  {pick.alert.type === "call" ? "C" : "P"} {formatExpiry(pick.alert.expiry)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{formatDte(pick.dte)}</span>
                </div>
                <Badge
                  className={cn(
                    "shrink-0 rounded-md",
                    pick.confidence >= 70 ? "bg-emerald-500/15 text-emerald-200" : "bg-zinc-500/15 text-zinc-200",
                  )}
                >
                  {pick.confidence}%
                </Badge>
              </div>
              <p className="text-sm leading-relaxed">{pick.aiReason}</p>
              <div className="grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
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
                  {pick.exitPlan.timeStop?.date ?? "—"}
                </div>
              </div>
              {pick.exitPlan.timeStop?.rule ? (
                <div className="text-[10px] text-muted-foreground">{pick.exitPlan.timeStop.rule}</div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {skips.length > 0 ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Skipped ({skips.length})</summary>
          <ul className="mt-1 space-y-1">
            {skips.map((s) => (
              <li key={s.option_chain} className="break-words">
                <span className="mr-1 rounded bg-zinc-500/20 px-1 text-[10px]">SKIP</span>
                <span className="font-mono">{s.option_chain}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
