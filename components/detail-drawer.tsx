"use client";

import { useEffect, useMemo, useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { ConvictionMeter } from "@/components/conviction-meter";
import { HoldWindowCopy } from "@/components/hold-window-copy";
import { ScoreChips } from "@/components/score-chips";
import { TideBar } from "@/components/tide-bar";
import { cn } from "@/lib/utils";
import type { NetPremTick, RankedFlow, TideSnapshot } from "@/lib/types";
import {
  formatClock,
  formatCompact,
  formatDte,
  formatExpiry,
  formatFullPremium,
  formatPct,
  formatPremium,
  formatPrice,
  formatStrike,
} from "@/lib/format";
import { toNumber } from "@/lib/numbers";
import { EyeOff, Pin, PinOff } from "lucide-react";

function Sparkline({ ticks }: { ticks: NetPremTick[] }) {
  const values = ticks.map(
    (tick) => toNumber(tick.net_call_premium) - toNumber(tick.net_put_premium),
  );
  if (values.length < 2) {
    return <p className="text-xs text-muted-foreground">Not enough ticker ticks yet.</p>;
  }

  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const w = 320;
  const h = 72;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * w;
      const y = h - ((value - min) / span) * h;
      return `${x},${y}`;
    })
    .join(" ");

  const last = values[values.length - 1] ?? 0;
  const positive = last >= 0;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full">
      <polyline
        fill="none"
        stroke={positive ? "#34d399" : "#fb7185"}
        strokeWidth="2"
        points={points}
      />
    </svg>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-all font-mono text-xs">{value || "—"}</div>
    </div>
  );
}

export function DetailDrawer({
  row,
  marketTide,
  open,
  onOpenChange,
  note,
  onNote,
  tickerPinned,
  contractPinned,
  onPinTicker,
  onPinContract,
  onDismiss,
}: {
  row: RankedFlow | null;
  marketTide: TideSnapshot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  note?: string;
  onNote?: (id: string, note: string) => void;
  tickerPinned?: boolean;
  contractPinned?: boolean;
  onPinTicker?: (ticker: string) => void;
  onPinContract?: (row: RankedFlow) => void;
  onDismiss?: (row: RankedFlow) => void;
}) {
  const [tickCache, setTickCache] = useState<{
    ticker: string;
    ticks: NetPremTick[];
    tide: TideSnapshot | null;
  } | null>(null);

  const ticker = row?.alert.ticker;
  const ticks = tickCache && ticker && tickCache.ticker === ticker ? tickCache.ticks : null;
  const tickerTide = tickCache && ticker && tickCache.ticker === ticker ? tickCache.tide : null;

  useEffect(() => {
    if (!open || !ticker) return;
    let cancelled = false;

    fetch(`/api/ticker/${encodeURIComponent(ticker)}/net-prem`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          ticks?: NetPremTick[];
          tide?: TideSnapshot | null;
        };
        if (cancelled) return;
        setTickCache({
          ticker,
          ticks: payload.ticks ?? [],
          tide: payload.tide ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setTickCache({ ticker, ticks: [], tide: null });
      });

    return () => {
      cancelled = true;
    };
  }, [open, ticker]);

  const alert = row?.alert;
  const rawFields = useMemo(() => {
    if (!alert) return [];
    return [
      ["id", alert.id],
      ["ticker", alert.ticker],
      ["option_chain", alert.option_chain],
      ["type", alert.type],
      ["strike", alert.strike],
      ["expiry", alert.expiry],
      ["price", alert.price],
      ["bid", alert.bid],
      ["ask", alert.ask],
      ["underlying_price", alert.underlying_price],
      ["total_premium", alert.total_premium],
      ["total_ask_side_prem", alert.total_ask_side_prem],
      ["total_bid_side_prem", alert.total_bid_side_prem],
      ["total_size", String(alert.total_size)],
      ["trade_count", String(alert.trade_count)],
      ["volume", String(alert.volume)],
      ["open_interest", String(alert.open_interest)],
      ["volume_oi_ratio", alert.volume_oi_ratio],
      ["alert_rule", alert.alert_rule],
      ["issue_type", alert.issue_type],
      ["marketcap", alert.marketcap == null ? "" : String(alert.marketcap)],
      ["created_at", alert.created_at],
      ["all_opening_trades", String(alert.all_opening_trades)],
      ["has_sweep", String(alert.has_sweep)],
      ["has_floor", String(alert.has_floor)],
      ["has_singleleg", String(alert.has_singleleg)],
      ["has_multileg", String(alert.has_multileg)],
    ] as const;
  }, [alert]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        {row && alert ? (
          <>
            <SheetHeader className="border-b border-border/70">
              <SheetTitle className="flex items-center gap-2 font-mono text-lg">
                {alert.ticker}
                <Badge
                  className={cn(
                    "rounded-md uppercase",
                    alert.type === "call"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-rose-500/15 text-rose-300",
                  )}
                >
                  {alert.type}
                </Badge>
              </SheetTitle>
              <SheetDescription>
                {formatStrike(alert.strike)} {formatExpiry(alert.expiry)} · {formatDte(row.dte)} ·{" "}
                {alert.option_chain || "chain unknown"}
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Conviction
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      <ConvictionMeter score={row.score} />
                      {row.fadeProne ? (
                        <Badge className="rounded-md bg-rose-500/15 text-rose-300">Fade-prone</Badge>
                      ) : (
                        <Badge className="rounded-md bg-emerald-500/15 text-emerald-300">
                          Hold-worthy
                        </Badge>
                      )}
                    </div>
                    <HoldWindowCopy hold={row.holdWindow} className="mt-2 max-w-sm" />
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Premium
                    </div>
                    <div className="font-mono text-xl text-amber-200">
                      {formatFullPremium(alert.total_premium)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {onPinTicker ? (
                    <Button
                      size="sm"
                      variant={tickerPinned ? "secondary" : "outline"}
                      onClick={() => onPinTicker(alert.ticker)}
                    >
                      {tickerPinned ? <PinOff /> : <Pin />}
                      {tickerPinned ? "Unpin ticker" : "Pin ticker"}
                    </Button>
                  ) : null}
                  {onPinContract && alert.option_chain ? (
                    <Button
                      size="sm"
                      variant={contractPinned ? "secondary" : "outline"}
                      onClick={() => onPinContract(row)}
                    >
                      {contractPinned ? <PinOff /> : <Pin />}
                      {contractPinned ? "Unpin contract" : "Pin contract"}
                    </Button>
                  ) : null}
                  {onDismiss ? (
                    <Button size="sm" variant="destructive" onClick={() => onDismiss(row)}>
                      <EyeOff />
                      Dismiss
                    </Button>
                  ) : null}
                </div>

                {onNote ? (
                  <label className="block">
                    <span className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Manager note
                    </span>
                    <Textarea
                      value={note ?? ""}
                      placeholder="Optional note for this setup."
                      className="min-h-20 text-sm"
                      onChange={(event) => onNote(alert.id, event.target.value)}
                    />
                  </label>
                ) : null}

                <div className="grid grid-cols-2 gap-2">
                  <Field label="Spot" value={formatPrice(alert.underlying_price)} />
                  <Field label="Option px" value={formatPrice(alert.price)} />
                  <Field label="Bid / ask" value={`${formatPrice(alert.bid)} / ${formatPrice(alert.ask)}`} />
                  <Field label="Ask share" value={formatPct(row.askShare)} />
                  <Field label="Size" value={formatCompact(alert.total_size)} />
                  <Field label="Trades" value={String(alert.trade_count)} />
                  <Field label="Volume" value={formatCompact(alert.volume)} />
                  <Field label="Open interest" value={formatCompact(alert.open_interest)} />
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Score breakdown
                  </div>
                  <ScoreChips chips={row.chips} />
                </div>

                <Separator />

                <TideBar tide={marketTide} label="Market tide" />
                <TideBar tide={tickerTide} label={`${alert.ticker} net prem`} />
                {ticks ? <Sparkline ticks={ticks} /> : (
                  <div className="h-16 animate-pulse rounded-md bg-muted/40" />
                )}

                <div className="rounded-lg border border-border/70 bg-muted/10 p-3 text-xs leading-relaxed text-muted-foreground">
                  Ask-side {formatPremium(alert.total_ask_side_prem)} vs bid-side{" "}
                  {formatPremium(alert.total_bid_side_prem)}. Printed {formatClock(alert.created_at)} ET.
                  This is a screener, not a broker — no routing, no auto-entries.
                </div>

                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Unusual Whales fields
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {rawFields.map(([label, value]) => (
                      <Field key={label} label={label} value={value} />
                    ))}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
