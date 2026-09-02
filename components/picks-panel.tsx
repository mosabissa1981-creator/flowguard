"use client";

import { Pin, PinOff, EyeOff, StickyNote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConvictionMeter } from "@/components/conviction-meter";
import { HoldWindowCopy } from "@/components/hold-window-copy";
import { cn } from "@/lib/utils";
import type { DailyPick } from "@/lib/types";
import { formatDte, formatExpiry, formatPremium, formatStrike } from "@/lib/format";
import { contractWatched, tickerWatched, type ManagerNoteMap, type WatchTarget } from "@/lib/manager";

export function PicksPanel({
  picks,
  loading,
  notes,
  watchlist,
  onSelect,
  onNote,
  onPinTicker,
  onPinContract,
  onDismiss,
}: {
  picks: DailyPick[];
  loading: boolean;
  notes: ManagerNoteMap;
  watchlist: WatchTarget[];
  onSelect: (id: string) => void;
  onNote: (id: string, note: string) => void;
  onPinTicker: (ticker: string) => void;
  onPinContract: (pick: DailyPick) => void;
  onDismiss: (pick: DailyPick) => void;
}) {
  return (
    <section className="rounded-xl border border-amber-400/20 bg-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-200/80">
            Manager · Picks of the Day
          </div>
          <h2 className="font-medium">Highest-conviction options setups after strict anti-fade</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Same Unusual Whales tape and conviction score as the live feed. Lottery DTE, tiny
            premium, bid-side dumps, and fighting-tide prints are already cut. Each pick has an
            options hold window — never a stock hold, never hold to expiry.
          </p>
        </div>
        <Badge className="rounded-md bg-amber-500/15 text-amber-200">
          {picks.length} pick{picks.length === 1 ? "" : "s"}
        </Badge>
      </div>

      {loading && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Building the book from ranked flow…</p>
      ) : picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No setups cleared strict anti-fade. Restore dismissed alerts or wait for the next print.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {picks.map((pick, index) => {
            const pinnedTicker = tickerWatched(watchlist, pick.alert.ticker);
            const pinnedContract = pick.alert.option_chain
              ? contractWatched(watchlist, pick.alert.option_chain)
              : false;
            return (
              <article
                key={pick.alert.id}
                className="flex flex-col gap-3 rounded-lg border border-border/70 bg-background/40 p-3"
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
                    {pick.fadeRisks.map((risk) => (
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

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant={pinnedTicker ? "secondary" : "outline"}
                    onClick={() => onPinTicker(pick.alert.ticker)}
                  >
                    {pinnedTicker ? <PinOff /> : <Pin />}
                    {pinnedTicker ? "Unpin ticker" : "Pin ticker"}
                  </Button>
                  {pick.alert.option_chain ? (
                    <Button
                      size="sm"
                      variant={pinnedContract ? "secondary" : "outline"}
                      onClick={() => onPinContract(pick)}
                    >
                      {pinnedContract ? <PinOff /> : <Pin />}
                      {pinnedContract ? "Unpin contract" : "Pin contract"}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => onSelect(pick.alert.id)}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onDismiss(pick)}
                  >
                    <EyeOff />
                    Dismiss
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
