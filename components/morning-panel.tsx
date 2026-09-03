"use client";

import { Snowflake, StickyNote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConvictionMeter } from "@/components/conviction-meter";
import { HoldWindowCopy } from "@/components/hold-window-copy";
import { PickWatchControls } from "@/components/pick-watch-controls";
import { cn } from "@/lib/utils";
import type { DailyPick, MorningShortlistResponse, PriceWatch } from "@/lib/types";
import { formatDte, formatExpiry, formatPremium, formatStrike } from "@/lib/format";
import type { ManagerNoteMap } from "@/lib/manager";

export function MorningPanel({
  morning,
  loading,
  notes,
  onSelect,
  onNote,
  priceWatches,
  onSavePriceWatch,
}: {
  morning: MorningShortlistResponse | null;
  loading: boolean;
  notes: ManagerNoteMap;
  onSelect: (id: string) => void;
  onNote: (id: string, note: string) => void;
  priceWatches: PriceWatch[];
  onSavePriceWatch: (watch: PriceWatch) => void;
}) {
  const picks = morning?.picks ?? [];
  const label = morning?.snapshotLabel ?? "Morning shortlist";

  return (
    <section className="rounded-xl border border-sky-400/20 bg-gradient-to-b from-sky-950/30 to-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Snowflake className="size-4 text-sky-300" />
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-200/80">
              Manager · Morning shortlist
            </span>
          </div>
          <h2 className="mt-1 font-medium">
            {label}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Frozen pre-open tape snapshot. This list does not update mid-session — the live Picks of
            the Day below continues to reflect the current tape in real time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="rounded-md bg-sky-500/15 text-sky-200">
            <Snowflake className="mr-1 size-3" />
            Frozen
          </Badge>
          <Badge className="rounded-md bg-sky-500/15 text-sky-200">
            {picks.length} setup{picks.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      {morning?.warning ? (
        <p className="mb-3 text-xs text-amber-300">{morning.warning}</p>
      ) : null}

      {loading && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading the morning shortlist…</p>
      ) : picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No setups cleared strict anti-fade in the morning window.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {picks.map((pick: DailyPick, index: number) => (
            <article
              key={pick.alert.id}
              className="flex flex-col gap-3 rounded-lg border border-sky-400/15 bg-background/40 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onSelect(pick.alert.id)}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="font-mono text-base font-semibold tracking-wide">
                      {pick.alert.ticker}
                    </span>
                    <Badge
                      className={cn(
                        "rounded-md font-mono text-[10px] uppercase",
                        pick.alert.type === "call"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-rose-500/15 text-rose-300",
                      )}
                    >
                      {pick.alert.type}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {formatStrike(pick.alert.strike)} {formatExpiry(pick.alert.expiry)} ·{" "}
                      {formatDte(pick.dte)}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-amber-200">
                    {formatPremium(pick.alert.total_premium)} premium
                  </div>
                </button>
                <ConvictionMeter score={pick.score} />
              </div>

              <HoldWindowCopy hold={pick.holdWindow} />

              <p className="text-sm leading-relaxed text-foreground/90">{pick.thesis}</p>

              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-rose-300/80">
                  Fade risks
                </div>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {pick.fadeRisks.map((risk: string) => (
                    <li key={risk} className="leading-relaxed">
                      — {risk}
                    </li>
                  ))}
                </ul>
              </div>

              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  <StickyNote className="size-3" />
                  Manager note
                </span>
                <Textarea
                  value={notes[pick.alert.id] ?? ""}
                  placeholder="Optional — thesis tweak, size, or why you are skipping."
                  className="min-h-16 text-sm"
                  onChange={(event) => onNote(pick.alert.id, event.target.value)}
                />
              </label>

              {pick.alert.option_chain ? (
                <PickWatchControls
                  seed={{
                    ticker: pick.alert.ticker,
                    option_chain: pick.alert.option_chain,
                    strike: pick.alert.strike,
                    expiry: pick.alert.expiry,
                    type: pick.alert.type,
                    price: pick.alert.price,
                  }}
                  watches={priceWatches}
                  onSave={onSavePriceWatch}
                />
              ) : null}

              <Button size="sm" variant="ghost" onClick={() => onSelect(pick.alert.id)}>
                Open detail
              </Button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
