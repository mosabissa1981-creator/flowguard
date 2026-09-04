"use client";

import { Radar, StickyNote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ConvictionMeter } from "@/components/conviction-meter";
import { HoldWindowCopy } from "@/components/hold-window-copy";
import { PickWatchControls } from "@/components/pick-watch-controls";
import { ScoreChips } from "@/components/score-chips";
import { cn } from "@/lib/utils";
import type { DailyPick, PicksResponse, PriceWatch, ScoreChip } from "@/lib/types";
import { formatDte, formatExpiry, formatPremium, formatStrike } from "@/lib/format";
import type { ManagerNoteMap } from "@/lib/manager";

const WHY_CHIP_ORDER = ["building", "quiet", "fresh", "with-tide", "chain-repeat", "mid-size"];

function whyChips(chips: ScoreChip[]): ScoreChip[] {
  const mapped = chips.map((chip) =>
    chip.id === "with-tide" ? { ...chip, label: "Tide aligned" } : chip,
  );
  return [...mapped].sort((a, b) => {
    const ai = WHY_CHIP_ORDER.indexOf(a.id);
    const bi = WHY_CHIP_ORDER.indexOf(b.id);
    const av = ai === -1 ? 50 : ai;
    const bv = bi === -1 ? 50 : bi;
    if (av !== bv) return av - bv;
    return b.delta - a.delta;
  });
}

export function PremovePanel({
  premove,
  loading,
  notes,
  onSelect,
  onNote,
  priceWatches,
  onSavePriceWatch,
}: {
  premove: PicksResponse | null;
  loading: boolean;
  notes: ManagerNoteMap;
  onSelect: (id: string) => void;
  onNote: (id: string, note: string) => void;
  priceWatches: PriceWatch[];
  onSavePriceWatch: (watch: PriceWatch, resolvePremium?: boolean) => void;
}) {
  const picks = premove?.picks ?? [];

  return (
    <section className="rounded-xl border border-violet-400/25 bg-gradient-to-b from-violet-950/35 to-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Radar className="size-4 text-violet-300" />
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-200/80">
              Manager · Premove
            </span>
          </div>
          <h2 className="mt-1 font-medium">Before the move — building ask-side flow</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Early detection: multiple ask-side hits on a name while the stock is still relatively
            quiet vs yesterday&apos;s close. This is not a prediction, not a crystal ball, and not
            financial advice. Picks of the Day below is the larger, cleaner-print lane.
          </p>
        </div>
        <Badge className="rounded-md bg-violet-500/15 text-violet-200">
          {picks.length} setup{picks.length === 1 ? "" : "s"}
        </Badge>
      </div>

      {premove?.warning ? (
        <p className="mb-3 text-xs text-amber-300">{premove.warning}</p>
      ) : null}

      {loading && picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Scanning session tape for building flow…</p>
      ) : picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sparse. No stacked ask-side setups on a still-quiet underlying right now.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {picks.map((pick: DailyPick, index: number) => (
            <article
              key={pick.alert.id}
              className="flex flex-col gap-3 rounded-lg border border-violet-400/15 bg-background/40 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="min-w-0 text-left" onClick={() => onSelect(pick.alert.id)}>
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
                  <div className="mt-1 font-mono text-xs text-violet-200">
                    {formatPremium(pick.alert.total_premium)} premium · premove {pick.score}
                  </div>
                </button>
                <ConvictionMeter score={pick.score} />
              </div>

              <ScoreChips chips={whyChips(pick.chips)} limit={5} compact />
              <HoldWindowCopy hold={pick.holdWindow} />
              <p className="text-sm leading-relaxed text-foreground/90">{pick.thesis}</p>

              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-rose-300/80">Fade risks</div>
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
                  placeholder="Optional — why you are watching this before a move."
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
            </article>
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground">
        Not financial advice. FlowGuard does not route orders or place trades.
      </p>
    </section>
  );
}
