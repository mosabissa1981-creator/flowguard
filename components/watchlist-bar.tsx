"use client";

import { useState } from "react";
import { Pin, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatExpiry, formatStrike } from "@/lib/format";
import type { WatchTarget } from "@/lib/manager";
import { parseTickerInput } from "@/lib/manager";

export function WatchlistBar({
  watchlist,
  watchlistOnly,
  onWatchlistOnly,
  onAddTicker,
  onRemove,
}: {
  watchlist: WatchTarget[];
  watchlistOnly: boolean;
  onWatchlistOnly: (value: boolean) => void;
  onAddTicker: (ticker: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const ticker = parseTickerInput(draft);
    if (!ticker) {
      setError("Enter a ticker like NVDA or AAPL.");
      return;
    }
    onAddTicker(ticker);
    setDraft("");
    setError(null);
  }

  return (
    <section className="rounded-xl border border-border/80 bg-card/80 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Manager · Watchlist
          </div>
          <p className="text-sm text-muted-foreground">
            Pin names or specific option contracts. Stored in this browser only.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={watchlistOnly} onCheckedChange={onWatchlistOnly} />
          Watchlist only
        </label>
      </div>

      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          value={draft}
          placeholder="Add ticker"
          className="w-36 font-mono uppercase"
          onChange={(event) => {
            setDraft(event.target.value.toUpperCase());
            setError(null);
          }}
        />
        <Button type="submit" size="sm">
          <Pin />
          Pin ticker
        </Button>
        {error ? <span className="self-center text-xs text-rose-300">{error}</span> : null}
      </form>

      {watchlist.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Empty book. Pin from a pick, a tape row, or the box above.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {watchlist.map((item) => (
            <Badge
              key={item.id}
              variant="outline"
              className={cn(
                "h-7 gap-1 rounded-md border-amber-400/30 bg-amber-400/10 pr-1 font-mono text-amber-100",
              )}
            >
              {item.kind === "ticker"
                ? item.ticker
                : `${item.ticker} ${item.strike ? formatStrike(item.strike) : ""} ${item.type === "put" ? "P" : "C"} ${item.expiry ? formatExpiry(item.expiry) : ""}`.trim()}
              <button
                type="button"
                className="rounded-sm p-0.5 hover:bg-amber-400/20"
                aria-label={`Unpin ${item.ticker}`}
                onClick={() => onRemove(item.id)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}
