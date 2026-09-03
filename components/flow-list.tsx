import { Pin, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConvictionMeter } from "@/components/conviction-meter";
import { HoldWindowCopy } from "@/components/hold-window-copy";
import { PickWatchControls } from "@/components/pick-watch-controls";
import { ScoreChips } from "@/components/score-chips";
import type { PriceWatch, RankedFlow } from "@/lib/types";
import {
  formatDte,
  formatExpiry,
  formatPct,
  formatPremium,
  formatRelativeTime,
  formatStrike,
} from "@/lib/format";
import { toNumber } from "@/lib/numbers";
import { isWatched, type WatchTarget } from "@/lib/manager";

function SideBadge({ type }: { type: "call" | "put" }) {
  return (
    <Badge
      className={cn(
        "rounded-md font-mono text-[10px] uppercase",
        type === "call"
          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
          : "border-rose-500/30 bg-rose-500/15 text-rose-300",
      )}
    >
      {type}
    </Badge>
  );
}

function AskBidSplit({ askShare }: { askShare: number }) {
  return (
    <div className="min-w-24">
      <div className="flex h-1 overflow-hidden rounded-full bg-rose-500/30">
        <div className="bg-emerald-400" style={{ width: `${askShare * 100}%` }} />
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        Ask {formatPct(askShare)}
      </div>
    </div>
  );
}

export function FlowList({
  items,
  selectedId,
  watchlist,
  onSelect,
  onPinTicker,
  onDismiss,
  priceWatches = [],
  onSavePriceWatch,
}: {
  items: RankedFlow[];
  selectedId: string | null;
  watchlist: WatchTarget[];
  onSelect: (id: string) => void;
  onPinTicker: (ticker: string) => void;
  onDismiss: (row: RankedFlow) => void;
  priceWatches?: PriceWatch[];
  onSavePriceWatch?: (watch: PriceWatch) => void;
}) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-border/80 bg-card/70 lg:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Conv</th>
              <th className="px-3 py-2.5 font-medium">Ticker</th>
              <th className="px-3 py-2.5 font-medium">Contract</th>
              <th className="px-3 py-2.5 font-medium">Premium</th>
              <th className="px-3 py-2.5 font-medium">Ask / bid</th>
              <th className="px-3 py-2.5 font-medium">Vol/OI</th>
              <th className="px-3 py-2.5 font-medium">Why</th>
              <th className="px-3 py-2.5 font-medium">Time</th>
              <th className="px-3 py-2.5 font-medium">Mgr</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const selected = row.alert.id === selectedId;
              const watched = isWatched(watchlist, row.alert.ticker, row.alert.option_chain);
              return (
                <tr
                  key={row.alert.id}
                  onClick={() => onSelect(row.alert.id)}
                  className={cn(
                    "cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/35",
                    selected && "bg-muted/50",
                    row.fadeProne && "opacity-80",
                    watched && "bg-amber-400/5",
                  )}
                >
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {String(row.rank).padStart(2, "0")}
                  </td>
                  <td className="px-3 py-3">
                    <ConvictionMeter score={row.score} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-wide">
                      {row.alert.ticker}
                      {watched ? <Pin className="size-3 text-amber-300" /> : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {row.alert.alert_rule || "Flow"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <SideBadge type={row.alert.type} />
                      <span className="font-mono text-xs">
                        {formatStrike(row.alert.strike)} {formatExpiry(row.alert.expiry)}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatDte(row.dte)}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {row.alert.has_sweep ? "SWEEP" : row.alert.has_floor ? "FLOOR" : "PRINT"}
                      {row.alert.all_opening_trades ? " · OPEN" : ""}
                    </div>
                    <HoldWindowCopy hold={row.holdWindow} compact className="mt-1.5 max-w-56" />
                  </td>
                  <td className="px-3 py-3 font-mono text-sm text-amber-200">
                    {formatPremium(row.alert.total_premium)}
                  </td>
                  <td className="px-3 py-3">
                    <AskBidSplit askShare={row.askShare} />
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {toNumber(row.alert.volume_oi_ratio).toFixed(2)}x
                  </td>
                  <td className="max-w-72 px-3 py-3">
                    <ScoreChips chips={row.chips} limit={3} compact />
                  </td>
                  <td className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
                    {formatRelativeTime(row.alert.created_at)}
                  </td>
                  <td className="px-2 py-3" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Pin ${row.alert.ticker}`}
                        onClick={() => onPinTicker(row.alert.ticker)}
                      >
                        <Pin className={watched ? "text-amber-300" : undefined} />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Dismiss alert"
                        onClick={() => onDismiss(row)}
                      >
                        <EyeOff />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 lg:hidden">
        {items.map((row) => {
          const selected = row.alert.id === selectedId;
          const watched = isWatched(watchlist, row.alert.ticker, row.alert.option_chain);
          return (
            <div
              key={row.alert.id}
              className={cn(
                "rounded-xl border border-border/80 bg-card/80 p-3 text-left",
                selected && "ring-1 ring-amber-400/40",
                watched && "border-amber-400/30",
              )}
            >
              <button type="button" className="w-full text-left" onClick={() => onSelect(row.alert.id)}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base font-semibold">{row.alert.ticker}</span>
                      <SideBadge type={row.alert.type} />
                      {watched ? <Pin className="size-3 text-amber-300" /> : null}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {formatStrike(row.alert.strike)} {formatExpiry(row.alert.expiry)} ·{" "}
                      {formatDte(row.dte)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-amber-200">
                      {formatPremium(row.alert.total_premium)}
                    </div>
                    <ConvictionMeter score={row.score} size="sm" />
                  </div>
                </div>
                <div className="mt-3">
                  <ScoreChips chips={row.chips} limit={4} compact />
                </div>
                <HoldWindowCopy hold={row.holdWindow} compact className="mt-2" />
              </button>
              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => onPinTicker(row.alert.ticker)}>
                  <Pin /> Pin
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDismiss(row)}>
                  <EyeOff /> Dismiss
                </Button>
              </div>
              {onSavePriceWatch && row.alert.option_chain ? (
                <div className="mt-2">
                  <PickWatchControls
                    seed={{
                      ticker: row.alert.ticker,
                      option_chain: row.alert.option_chain,
                      strike: row.alert.strike,
                      expiry: row.alert.expiry,
                      type: row.alert.type,
                      price: row.alert.price,
                    }}
                    watches={priceWatches}
                    onSave={onSavePriceWatch}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function FlowListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}
