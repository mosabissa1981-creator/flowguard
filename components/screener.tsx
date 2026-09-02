"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw, ShieldAlert, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterBar } from "@/components/filter-bar";
import { FlowList, FlowListSkeleton } from "@/components/flow-list";
import { DetailDrawer } from "@/components/detail-drawer";
import { TideBar } from "@/components/tide-bar";
import { PicksPanel } from "@/components/picks-panel";
import { WatchlistBar } from "@/components/watchlist-bar";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { DailyPick, FlowFilters, FlowResponse, PicksResponse, RankedFlow } from "@/lib/types";
import { formatClock } from "@/lib/format";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  DISMISSED_KEY,
  EMPTY_DISMISSED,
  EMPTY_NOTES,
  EMPTY_WATCHLIST,
  NOTES_KEY,
  WATCHLIST_KEY,
  contractWatched,
  isWatched,
  makeContractTarget,
  makeTickerTarget,
  tickerWatched,
  watchContractId,
  watchTickerId,
  type DismissedAlert,
  type ManagerNoteMap,
  type WatchTarget,
} from "@/lib/manager";

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
  const [picksData, setPicksData] = useState<PicksResponse | null>(null);
  const [picksLoading, setPicksLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const [watchlist, setWatchlist] = usePersistentState<WatchTarget[]>(
    WATCHLIST_KEY,
    EMPTY_WATCHLIST,
  );
  const [notes, setNotes] = usePersistentState<ManagerNoteMap>(NOTES_KEY, EMPTY_NOTES);
  const [dismissed, setDismissed] = usePersistentState<DismissedAlert[]>(
    DISMISSED_KEY,
    EMPTY_DISMISSED,
  );

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(filters), 280);
    return () => window.clearTimeout(handle);
  }, [filters]);

  const query = useMemo(() => toQuery(debounced), [debounced]);
  const dismissedIds = useMemo(() => new Set(dismissed.map((item) => item.id)), [dismissed]);

  const loadFlow = useCallback(async () => {
    const response = await fetch(`/api/flow?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Screener route failed (${response.status})`);
    return (await response.json()) as FlowResponse;
  }, [query]);

  const loadPicks = useCallback(async () => {
    const response = await fetch("/api/picks", { cache: "no-store" });
    if (!response.ok) throw new Error(`Picks route failed (${response.status})`);
    return (await response.json()) as PicksResponse;
  }, []);

  const load = useCallback(async () => {
    try {
      const [flow, picks] = await Promise.all([loadFlow(), loadPicks()]);
      setData(flow);
      setPicksData(picks);
      setError(null);
      setLoading(false);
      setPicksLoading(false);
      setRefreshing(false);
      setSecondsLeft(REFRESH_MS / 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load flow.");
      setLoading(false);
      setPicksLoading(false);
      setRefreshing(false);
    }
  }, [loadFlow, loadPicks]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const [flowRes, picksRes] = await Promise.all([
          fetch(`/api/flow?${query}`, { cache: "no-store", signal: controller.signal }),
          fetch("/api/picks", { cache: "no-store", signal: controller.signal }),
        ]);
        if (!flowRes.ok) throw new Error(`Screener route failed (${flowRes.status})`);
        if (!picksRes.ok) throw new Error(`Picks route failed (${picksRes.status})`);
        setData((await flowRes.json()) as FlowResponse);
        setPicksData((await picksRes.json()) as PicksResponse);
        setError(null);
        setLoading(false);
        setPicksLoading(false);
        setSecondsLeft(REFRESH_MS / 1000);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Could not load flow.");
        setLoading(false);
        setPicksLoading(false);
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

  const visibleItems = useMemo(() => {
    const rows = (data?.items ?? []).filter((row) => !dismissedIds.has(row.alert.id));
    if (!watchlistOnly) return rows;
    return rows.filter((row) => isWatched(watchlist, row.alert.ticker, row.alert.option_chain));
  }, [data?.items, dismissedIds, watchlist, watchlistOnly]);

  const visiblePicks = useMemo(
    () => (picksData?.picks ?? []).filter((pick) => !dismissedIds.has(pick.alert.id)),
    [picksData?.picks, dismissedIds],
  );

  const selected: RankedFlow | DailyPick | null =
    visibleItems.find((row) => row.alert.id === selectedId) ??
    visiblePicks.find((row) => row.alert.id === selectedId) ??
    null;

  function toggleTicker(ticker: string) {
    const id = watchTickerId(ticker);
    setWatchlist((prev) => {
      if (prev.some((item) => item.id === id)) return prev.filter((item) => item.id !== id);
      return [...prev, makeTickerTarget(ticker)];
    });
  }

  function toggleContract(row: RankedFlow) {
    if (!row.alert.option_chain) return;
    const id = watchContractId(row.alert.option_chain);
    setWatchlist((prev) => {
      if (prev.some((item) => item.id === id)) return prev.filter((item) => item.id !== id);
      return [
        ...prev,
        makeContractTarget({
          ticker: row.alert.ticker,
          option_chain: row.alert.option_chain,
          strike: row.alert.strike,
          expiry: row.alert.expiry,
          type: row.alert.type,
        }),
      ];
    });
  }

  function dismissRow(row: RankedFlow) {
    setDismissed((prev) => {
      if (prev.some((item) => item.id === row.alert.id)) return prev;
      return [
        ...prev,
        {
          id: row.alert.id,
          ticker: row.alert.ticker,
          option_chain: row.alert.option_chain,
          dismissedAt: new Date().toISOString(),
        },
      ];
    });
    if (selectedId === row.alert.id) setSelectedId(null);
  }

  function restoreAlert(id: string) {
    setDismissed((prev) => prev.filter((item) => item.id !== id));
  }

  function writeNote(id: string, note: string) {
    setNotes((prev) => {
      if (!note.trim()) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: note };
    });
  }

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
                <Badge className="rounded-md bg-amber-500/15 text-[10px] uppercase tracking-widest text-amber-200">
                  Manager
                </Badge>
              </div>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Manager book on top of ranked unusual options flow. Pin contracts, annotate picks,
                and dismiss noise — scoring still comes from Unusual Whales.
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
              ? `${visibleItems.length} on tape · ${visiblePicks.length} picks · ${dismissed.length} dismissed · ${formatClock(data.fetchedAt)} ET`
              : "Waiting for tape…"}
          </span>
          {data?.warning ? <span className="text-amber-300">{data.warning}</span> : null}
        </div>
      </header>

      <PicksPanel
        picks={visiblePicks}
        loading={picksLoading}
        notes={notes}
        watchlist={watchlist}
        onSelect={setSelectedId}
        onNote={writeNote}
        onPinTicker={toggleTicker}
        onPinContract={toggleContract}
        onDismiss={dismissRow}
      />

      <WatchlistBar
        watchlist={watchlist}
        watchlistOnly={watchlistOnly}
        onWatchlistOnly={setWatchlistOnly}
        onAddTicker={(ticker) => {
          const id = watchTickerId(ticker);
          setWatchlist((prev) =>
            prev.some((item) => item.id === id) ? prev : [...prev, makeTickerTarget(ticker)],
          );
        }}
        onRemove={(id) => setWatchlist((prev) => prev.filter((item) => item.id !== id))}
      />

      {dismissed.length > 0 ? (
        <section className="rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-medium">{dismissed.length} dismissed</span>
              <span className="text-muted-foreground"> — hidden from picks and the tape.</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDismissed(EMPTY_DISMISSED)}>
              <RotateCcw />
              Restore all
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {dismissed.map((item) => (
              <Button
                key={item.id}
                size="xs"
                variant="ghost"
                onClick={() => restoreAlert(item.id)}
              >
                {item.ticker}
                <RotateCcw />
              </Button>
            ))}
          </div>
        </section>
      ) : null}

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
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="font-medium">No flow survived these filters</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {watchlistOnly
              ? "Nothing on the tape matches the watchlist. Unpin Watchlist only, or pin another name."
              : dismissed.length > 0
                ? "Visible tape is empty. Restore dismissed alerts or loosen filters."
                : "Loosen min premium, widen DTE, drop min conviction, or turn off strict anti-fade."}
          </p>
        </div>
      ) : (
        <FlowList
          items={visibleItems}
          selectedId={selectedId}
          watchlist={watchlist}
          onSelect={setSelectedId}
          onPinTicker={toggleTicker}
          onDismiss={dismissRow}
        />
      )}

      <DetailDrawer
        row={selected}
        marketTide={data?.tide ?? null}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        note={selected ? notes[selected.alert.id] : ""}
        onNote={writeNote}
        tickerPinned={selected ? tickerWatched(watchlist, selected.alert.ticker) : false}
        contractPinned={
          selected?.alert.option_chain
            ? contractWatched(watchlist, selected.alert.option_chain)
            : false
        }
        onPinTicker={toggleTicker}
        onPinContract={toggleContract}
        onDismiss={dismissRow}
      />
    </div>
  );
}
