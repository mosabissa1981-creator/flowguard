"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Landmark } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CongressResponse, CongressSide, CongressTrade } from "@/lib/types";

const FETCH_MS = 25_000;

const SIDES: { id: CongressSide; label: string }[] = [
  { id: "buy", label: "Buys" },
  { id: "sell", label: "Sells" },
  { id: "all", label: "All" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDisclosureDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return "—";
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

function chamberLabel(memberType: string | null): string {
  if (!memberType) return "—";
  if (memberType === "house") return "House";
  if (memberType === "senate") return "Senate";
  return memberType.charAt(0).toUpperCase() + memberType.slice(1);
}

function issuerLabel(issuer: string | null): string | null {
  if (!issuer) return null;
  return issuer.charAt(0).toUpperCase() + issuer.slice(1);
}

async function fetchCongress(side: CongressSide, forceFresh: boolean): Promise<CongressResponse> {
  const params = new URLSearchParams({ side, limit: "40", days: "7" });
  if (forceFresh) params.set("fresh", "1");
  const response = await fetch(`/api/congress?${params.toString()}`, {
    cache: "no-store",
    signal:
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(FETCH_MS)
        : undefined,
  });
  if (!response.ok) {
    throw new Error(`Congress request failed (${response.status})`);
  }
  return (await response.json()) as CongressResponse;
}

function TradeRow({ trade }: { trade: CongressTrade }) {
  const issuer = issuerLabel(trade.issuer);
  const buy = trade.side === "buy";
  const sell = trade.side === "sell";

  return (
    <article className="grid gap-1.5 rounded-lg border border-amber-400/10 bg-background/40 px-3 py-2.5 md:grid-cols-[minmax(0,1.6fr)_4.5rem_5.2rem_minmax(8.5rem,1fr)_6.6rem_6.6rem_4.4rem] md:items-center md:gap-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{trade.name}</div>
        {issuer ? <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{issuer}</div> : null}
      </div>
      <div className="font-mono text-sm font-semibold tracking-wide">{trade.ticker}</div>
      <div>
        <Badge
          className={cn(
            "rounded-md font-mono text-[10px] uppercase",
            buy && "bg-emerald-500/15 text-emerald-300",
            sell && "bg-rose-500/15 text-rose-300",
            !buy && !sell && "bg-muted text-muted-foreground",
          )}
        >
          {trade.txnType}
        </Badge>
      </div>
      <div className="font-mono text-xs text-foreground/90">{trade.amounts}</div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">Transaction</div>
        <div className="font-mono text-xs">{formatDisclosureDate(trade.transactionDate)}</div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground md:hidden">Filed</div>
        <div className="font-mono text-xs text-amber-100/90">{formatDisclosureDate(trade.filedAtDate)}</div>
      </div>
      <div className="text-xs text-muted-foreground">{chamberLabel(trade.memberType)}</div>
    </article>
  );
}

export function CongressPanel({
  pollNonce = 0,
  cacheBust = 0,
}: {
  pollNonce?: number;
  cacheBust?: number;
}) {
  const [side, setSide] = useState<CongressSide>("buy");
  const [ticker, setTicker] = useState("");
  const [data, setData] = useState<CongressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const appliedBust = useRef(0);

  useEffect(() => {
    let stale = false;
    const bust = cacheBust !== appliedBust.current;
    void (async () => {
      setLoading(true);
      try {
        const payload = await fetchCongress(side, bust);
        if (stale) return;
        if (bust) appliedBust.current = cacheBust;
        setData(payload);
        setError(null);
      } catch (err) {
        if (stale) return;
        setError(err instanceof Error ? err.message : "Congress disclosures unavailable.");
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [side, pollNonce, cacheBust]);

  const aligned = Boolean(data && data.side === side);
  const trades = useMemo(() => {
    if (!data || data.side !== side) return [];
    const query = ticker.trim().toUpperCase();
    if (!query) return data.trades;
    return data.trades.filter(
      (trade) => trade.ticker.includes(query) || trade.name.toUpperCase().includes(query),
    );
  }, [data, side, ticker]);

  const heading =
    side === "sell" ? "Congress — recent sells" : side === "all" ? "Congress — recent trades" : "Congress — recent buys";
  const countLabel = side === "all" ? "trades" : side === "sell" ? "sells" : "buys";
  const statusMessage = error ?? (aligned && data && data.status !== "ok" ? data.message : null);

  return (
    <section className="rounded-xl border border-amber-400/20 bg-gradient-to-b from-stone-950/80 to-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="size-4 text-amber-200" />
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-200/80">
              Context · Congress
            </span>
          </div>
          <h2 className="mt-1 font-medium">{heading}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Delayed STOCK Act disclosures, filtered on filing date (
            <span className="font-mono text-xs">filed_at_date</span>
            ), last 7 days. Not trading advice. Separate from options flow — not used by Picks,
            Premove, or conviction.
          </p>
        </div>
        <Badge className="rounded-md bg-amber-500/15 text-amber-100">
          {loading && !aligned ? "…" : `${trades.length} ${countLabel}`}
        </Badge>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border/80 bg-background/40 p-0.5">
          {SIDES.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={side === option.id ? "secondary" : "ghost"}
              aria-pressed={side === option.id}
              onClick={() => setSide(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <Input
          value={ticker}
          placeholder="Filter ticker"
          aria-label="Filter congress rows by ticker"
          className="h-7 w-36 font-mono uppercase"
          onChange={(event) => setTicker(event.target.value.toUpperCase())}
        />
        {loading && aligned ? <span className="text-[11px] text-muted-foreground">Updating…</span> : null}
      </div>

      {statusMessage ? (
        <p className="mb-3 text-xs text-amber-200" role="status">
          {statusMessage}
        </p>
      ) : null}
      {aligned && data?.status === "ok" && data.warning ? (
        <p className="mb-3 text-xs text-amber-300">{data.warning}</p>
      ) : null}
      {aligned && data?.status === "ok" ? (
        <p className="mb-3 text-xs text-muted-foreground">{data.message}</p>
      ) : null}

      {loading && !aligned ? (
        <p className="text-sm text-muted-foreground">Loading congressional disclosures…</p>
      ) : aligned && data?.status === "ok" && trades.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {ticker.trim() ? "No loaded disclosure matches that ticker." : "Nothing in this window."}
        </p>
      ) : trades.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="hidden px-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground md:grid md:grid-cols-[minmax(0,1.6fr)_4.5rem_5.2rem_minmax(8.5rem,1fr)_6.6rem_6.6rem_4.4rem] md:gap-2">
            <span>Politician</span>
            <span>Ticker</span>
            <span>Type</span>
            <span>Amount</span>
            <span>Transaction</span>
            <span>Filed</span>
            <span>Chamber</span>
          </div>
          {trades.map((trade) => (
            <TradeRow key={trade.id} trade={trade} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
