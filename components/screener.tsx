"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterBar } from "@/components/filter-bar";
import { FlowList, FlowListSkeleton } from "@/components/flow-list";
import { DetailDrawer } from "@/components/detail-drawer";
import { TideBar } from "@/components/tide-bar";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { FlowFilters, FlowResponse, RankedFlow } from "@/lib/types";
import { formatClock } from "@/lib/format";

const REFRESH_MS = 45_000;

function toQuery(filters: FlowFilters): string {
  const params = new URLSearchParams({
    minPremium: String(filters.minPremium),
    minDte: String(filters.minDte),
    maxDte: String(filters.maxDte),
    side: filters.side,
    minConviction: String(filters.minConviction),
    unusual: String(filters.unusual),
    strictAntiFade: String(filters.strictAntiFade),
  });
  if (filters.ticker) params.set("ticker", filters.ticker);
  return params.toString();
}

export function Screener() {
  const [filters, setFilters] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [debounced, setDebounced] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FlowResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(filters), 280);
    return () => window.clearTimeout(handle);
  }, [filters]);

  const query = useMemo(() => toQuery(debounced), [debounced]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/flow?${query}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Screener route failed (${response.status})`);
      }
      const payload = (await response.json()) as FlowResponse;
      setData(payload);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      setSecondsLeft(REFRESH_MS / 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load flow.");
      setLoading(false);
      setRefreshing(false);
    }
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/flow?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Screener route failed (${response.status})`);
        }
        const payload = (await response.json()) as FlowResponse;
        setData(payload);
        setError(null);
        setLoading(false);
        setSecondsLeft(REFRESH_MS / 1000);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not load flow.");
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    if (paused) return;
    const interval = window.setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load, paused]);

  useEffect(() => {
    if (paused) return;
    const tick = window.setInterval(() => {
      setSecondsLeft((value) => (value <= 1 ? REFRESH_MS / 1000 : value - 1));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [paused]);

  const selected: RankedFlow | null =
    data?.items.find((row) => row.alert.id === selectedId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-200">
              <ShieldAlert className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-mono text-xl font-semibold tracking-[0.14em]">FLOWGUARD</h1>
                <Badge className="rounded-md bg-muted text-[10px] uppercase tracking-widest text-muted-foreground">
                  Options only
                </Badge>
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Rank unusual options flow by conviction. Downrank 0–2 DTE lotteries, tiny
                premium, bid-side dumps, and prints fighting the tape.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={
                data?.source === "live"
                  ? "rounded-md bg-emerald-500/15 text-emerald-300"
                  : "rounded-md bg-amber-500/15 text-amber-200"
              }
            >
              {data?.source === "live" ? "Live UW" : "Mock tape"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? "Resume" : `Pause · ${secondsLeft}s`}
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => {
                setRefreshing(true);
                void load();
              }}
              disabled={refreshing}
              aria-label="Refresh flow"
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            </Button>
          </div>
        </div>
        <TideBar tide={data?.tide ?? null} />
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
          <span>
            {data
              ? `${data.items.length} ranked · ${data.rawCount} raw alerts · ${formatClock(data.fetchedAt)} ET`
              : "Waiting for tape…"}
          </span>
          {data?.warning ? <span className="text-amber-300">{data.warning}</span> : null}
        </div>
      </header>

      <FilterBar filters={filters} onChange={setFilters} />

      {error ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
          {error}
          <Button className="ml-3" size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}

      {loading && !data ? (
        <FlowListSkeleton />
      ) : data && data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="font-medium">No flow survived these filters</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Loosen min premium, widen DTE, drop min conviction, or turn off strict anti-fade.
            Unusual preset still applies Unusual Whales live-flow defaults when a key is set.
          </p>
        </div>
      ) : data ? (
        <FlowList items={data.items} selectedId={selectedId} onSelect={setSelectedId} />
      ) : null}

      <DetailDrawer
        row={selected}
        marketTide={data?.tide ?? null}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </div>
  );
}
