"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw, ShieldAlert, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterBar } from "@/components/filter-bar";
import { FlowList, FlowListSkeleton } from "@/components/flow-list";
import { DetailDrawer } from "@/components/detail-drawer";
import { TideBar } from "@/components/tide-bar";
import { MorningPanel } from "@/components/morning-panel";
import { PremovePanel } from "@/components/premove-panel";
import { PicksPanel } from "@/components/picks-panel";
import { PriceWatchesPanel } from "@/components/price-watches-panel";
import { WatchlistBar } from "@/components/watchlist-bar";
import { UwKeyForm, UwKeyIcon } from "@/components/uw-key-form";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type {
  DailyPick,
  EvaluatedWatch,
  FlowFilters,
  FlowResponse,
  MorningShortlistResponse,
  PicksResponse,
  PriceWatch,
  RankedFlow,
  WatchCheckResponse,
} from "@/lib/types";
import { formatClock } from "@/lib/format";
import { toNumber } from "@/lib/numbers";
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
import { EMPTY_PRICE_WATCHES, PRICE_WATCHES_KEY, upsertWatch } from "@/lib/price-watches";

const REFRESH_MS = 45_000;
const FETCH_MS = 20_000;
const WATCH_CHECK_MS = 15 * 60_000;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    signal:
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(FETCH_MS)
        : undefined,
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

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

export function Screener({
  initialFlow,
  initialPicks,
  initialMorning,
  initialPremove,
  initialUwConfigured = false,
}: {
  initialFlow?: FlowResponse | null;
  initialPicks?: PicksResponse | null;
  initialMorning?: MorningShortlistResponse | null;
  initialPremove?: PicksResponse | null;
  initialUwConfigured?: boolean;
}) {
  const [filters, setFilters] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [debounced, setDebounced] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(!initialFlow);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FlowResponse | null>(initialFlow ?? null);
  const [picksData, setPicksData] = useState<PicksResponse | null>(initialPicks ?? null);
  const [picksLoading, setPicksLoading] = useState(!initialPicks);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const [morningData, setMorningData] = useState<MorningShortlistResponse | null>(
    initialMorning ?? null,
  );
  const [morningLoading, setMorningLoading] = useState(!initialMorning);
  const [premoveData, setPremoveData] = useState<PicksResponse | null>(initialPremove ?? null);
  const [premoveLoading, setPremoveLoading] = useState(!initialPremove);

  const [uwConfigured, setUwConfigured] = useState(initialUwConfigured);
  const [uwLocked, setUwLocked] = useState(false);
  const [uwKeyOpen, setUwKeyOpen] = useState(!initialUwConfigured);

  const [watchlist, setWatchlist] = usePersistentState<WatchTarget[]>(
    WATCHLIST_KEY,
    EMPTY_WATCHLIST,
  );
  const [notes, setNotes] = usePersistentState<ManagerNoteMap>(NOTES_KEY, EMPTY_NOTES);
  const [dismissed, setDismissed] = usePersistentState<DismissedAlert[]>(
    DISMISSED_KEY,
    EMPTY_DISMISSED,
  );
  const [priceWatches, setPriceWatches] = usePersistentState<PriceWatch[]>(
    PRICE_WATCHES_KEY,
    EMPTY_PRICE_WATCHES,
  );
  const [watchCheck, setWatchCheck] = useState<WatchCheckResponse | null>(null);
  const [watchesLoading, setWatchesLoading] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(filters), 280);
    return () => window.clearTimeout(handle);
  }, [filters]);

  const query = useMemo(() => toQuery(debounced), [debounced]);
  const dismissedIds = useMemo(() => new Set(dismissed.map((item) => item.id)), [dismissed]);

  const loadFlow = useCallback(async () => {
    return fetchJson<FlowResponse>(`/api/flow?${query}`);
  }, [query]);

  const loadPicks = useCallback(async () => {
    return fetchJson<PicksResponse>("/api/picks");
  }, []);

  const loadPremove = useCallback(async () => {
    return fetchJson<PicksResponse>("/api/premove");
  }, []);

  const watchPrints = useRef(new Map<string, number>());
  watchPrints.current = (() => {
    const prints = new Map<string, number>();
    for (const row of [...(data?.items ?? []), ...(picksData?.picks ?? []), ...(premoveData?.picks ?? [])]) {
      const price = toNumber(row.alert.price);
      if (row.alert.option_chain && price > 0) prints.set(row.alert.option_chain, price);
    }
    return prints;
  })();

  const checkWatches = useCallback(async (list: PriceWatch[]) => {
    if (list.length === 0) {
      setWatchCheck({ checkedAt: new Date().toISOString(), evaluations: [], alerts: [] });
      return;
    }
    const freshened = list.map((watch) => ({
      ...watch,
      lastFlowPrint: watchPrints.current.get(watch.option_chain) ?? watch.lastFlowPrint,
    }));
    setWatchesLoading(true);
    try {
      const payload = await fetch("/api/watches/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watches: freshened }),
        cache: "no-store",
      });
      if (!payload.ok) throw new Error(`Watch check failed (${payload.status})`);
      setWatchCheck((await payload.json()) as WatchCheckResponse);
    } catch {
      setWatchCheck({
        checkedAt: new Date().toISOString(),
        evaluations: list.map((watch) => ({
          watch,
          quote: null,
          status: "ok",
          pctMove: null,
          hint: null,
        })),
        alerts: [],
      });
    } finally {
      setWatchesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    const [flowResult, picksResult, premoveResult] = await Promise.allSettled([
      loadFlow(),
      loadPicks(),
      loadPremove(),
    ]);
    if (flowResult.status === "fulfilled") {
      setData(flowResult.value);
      setError(null);
    } else {
      setError(
        flowResult.reason instanceof Error ? flowResult.reason.message : "Could not load flow.",
      );
    }
    if (picksResult.status === "fulfilled") {
      setPicksData(picksResult.value);
    }
    if (premoveResult.status === "fulfilled") {
      setPremoveData(premoveResult.value);
    }
    setLoading(false);
    setPicksLoading(false);
    setPremoveLoading(false);
    setRefreshing(false);
    setSecondsLeft(REFRESH_MS / 1000);
  }, [loadFlow, loadPicks, loadPremove]);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const status = await fetchJson<{ configured: boolean; locked?: boolean }>("/api/uw-key");
        if (!stale) {
          setUwConfigured(status.configured);
          setUwLocked(Boolean(status.locked));
          if (status.configured) setUwKeyOpen(false);
        }
      } catch {
        // Status is optional; the connect form still works.
      }
    })();
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (morningData) {
      setMorningLoading(false);
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const morning = await fetchJson<MorningShortlistResponse>("/api/morning");
        if (!stale) {
          setMorningData(morning);
          setMorningLoading(false);
        }
      } catch {
        if (!stale) setMorningLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const serverWatches = await fetchJson<{ watches: PriceWatch[] }>("/api/watches");
        if (stale) return;
        const server = serverWatches.watches ?? [];
        const local = priceWatches;
        const merged = [...server];
        for (const localWatch of local) {
          if (!merged.some((sw) => sw.id === localWatch.id)) {
            merged.push(localWatch);
          }
        }
        setPriceWatches(merged);
        if (merged.length !== server.length) {
          void fetch("/api/watches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ watches: merged }),
          }).catch(() => {});
        }
      } catch {
        // Offline or no server watches — keep localStorage.
      }
    })();
    return () => {
      stale = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stale = false;

    void (async () => {
      try {
        const flow = await fetchJson<FlowResponse>(`/api/flow?${query}`);
        if (stale) return;
        setData(flow);
        setError(null);
        setLoading(false);
        setSecondsLeft(REFRESH_MS / 1000);
      } catch (err) {
        if (stale) return;
        setError(err instanceof Error ? err.message : "Could not load flow.");
        setLoading(false);
      }
    })();

    void (async () => {
      try {
        const picks = await fetchJson<PicksResponse>("/api/picks");
        if (stale) return;
        setPicksData(picks);
        setPicksLoading(false);
      } catch {
        if (stale) return;
        setPicksLoading(false);
      }
    })();

    return () => {
      stale = true;
    };
  }, [query]);

  useEffect(() => {
    void checkWatches(priceWatches);
    const id = window.setInterval(() => void checkWatches(priceWatches), WATCH_CHECK_MS);
    return () => window.clearInterval(id);
  }, [checkWatches, priceWatches]);

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
  const visiblePremove = useMemo(
    () => (premoveData?.picks ?? []).filter((pick) => !dismissedIds.has(pick.alert.id)),
    [premoveData?.picks, dismissedIds],
  );

  const selected: RankedFlow | DailyPick | null =
    visibleItems.find((row) => row.alert.id === selectedId) ??
    visiblePicks.find((row) => row.alert.id === selectedId) ??
    visiblePremove.find((row) => row.alert.id === selectedId) ??
    morningData?.picks.find((row) => row.alert.id === selectedId) ??
    null;

  const rejectMock = uwConfigured && (data?.source === "mock" || picksData?.source === "mock" || premoveData?.source === "mock");
  const quotaDown = Boolean(
    rejectMock ||
      data?.quotaBlocked ||
      data?.source === "cached" ||
      picksData?.quotaBlocked ||
      picksData?.source === "cached" ||
      premoveData?.quotaBlocked ||
      premoveData?.source === "cached",
  );
  const tapeBadge = quotaDown
    ? { label: "UW cap · not live", className: "rounded-md bg-rose-500/20 text-rose-200" }
    : data?.source === "live"
      ? { label: "Live UW", className: "rounded-md bg-emerald-500/15 text-emerald-300" }
      : uwConfigured
        ? { label: "Live UW", className: "rounded-md bg-emerald-500/15 text-emerald-300" }
        : { label: "Demo tape", className: "rounded-md bg-amber-500/15 text-amber-200" };
  const shownItems = quotaDown && rejectMock ? [] : visibleItems;
  const shownPicks = quotaDown && rejectMock ? [] : visiblePicks;
  const shownPremove = quotaDown && rejectMock ? [] : visiblePremove;

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

  function savePriceWatch(watch: PriceWatch, resolvePremium = true) {
    const next = upsertWatch(priceWatches, watch);
    setPriceWatches(next);
    void fetch("/api/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch, resolvePremium }),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { watch?: PriceWatch };
        if (payload.watch) {
          setPriceWatches((prev) => upsertWatch(prev, payload.watch as PriceWatch));
        }
      })
      .catch(() => {});
    void checkWatches(next);
  }

  function removePriceWatch(id: string) {
    const next = priceWatches.filter((item) => item.id !== id);
    setPriceWatches(next);
    void fetch(`/api/watches?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    void checkWatches(next);
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
                Manager book on top of ranked unusual options flow. Pin contracts, watch option
                premiums, annotate picks, and dismiss noise — scoring still comes from Unusual
                Whales. Never auto-trades.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={tapeBadge.className}>{tapeBadge.label}</Badge>
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
            <UwKeyIcon
              live={uwConfigured && !quotaDown}
              open={uwKeyOpen}
              onClick={() => setUwKeyOpen((value) => !value)}
            />
          </div>
        </div>
        <TideBar tide={rejectMock ? null : (data?.tide ?? null)} />
        <UwKeyForm
          configured={uwConfigured}
          open={uwKeyOpen}
          onClose={() => setUwKeyOpen(false)}
          locked={uwLocked}
          onConfigured={() => {
            setUwConfigured(true);
            setUwKeyOpen(false);
            setRefreshing(true);
            void load();
          }}
        />
        {quotaDown ? (
          <div className="rounded-lg border border-rose-400/50 bg-rose-950/70 p-3 text-sm text-rose-50">
            <div className="font-medium tracking-wide">Live data down — Unusual Whales daily cap.</div>
            <p className="mt-1 text-xs leading-relaxed text-rose-100/90">
              {data?.warning ??
                "Do not trade this screen. FlowGuard is not substituting the demo tape (no CRWD/SNOW/AVGO mock names)."}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
          <span>
            {data
              ? `${shownItems.length} on tape · ${shownPremove.length} premove · ${shownPicks.length} picks · ${dismissed.length} dismissed · ${formatClock(data.fetchedAt)} ET`
              : "Waiting for tape…"}
          </span>
          {!quotaDown && data?.warning ? <span className="text-amber-300">{data.warning}</span> : null}
        </div>
      </header>

      <MorningPanel
        morning={
          rejectMock && morningData?.source === "mock"
            ? {
                ...(morningData ?? {
                  source: "cached",
                  fetchedAt: "",
                  picks: [],
                  tide: null,
                  tradingDate: "",
                  snapshotLabel: "Morning shortlist",
                  frozen: true as const,
                }),
                picks: [],
                source: "cached",
                warning: data?.warning,
              }
            : morningData
        }
        loading={morningLoading}
        notes={notes}
        onSelect={setSelectedId}
        onNote={writeNote}
        priceWatches={priceWatches}
        onSavePriceWatch={savePriceWatch}
      />

      <PremovePanel
        premove={{
          ...(premoveData ?? { source: "live", fetchedAt: "", picks: [], tide: null }),
          picks: shownPremove,
          source: rejectMock ? "cached" : (premoveData?.source ?? "live"),
          warning: quotaDown ? data?.warning ?? premoveData?.warning : premoveData?.warning,
        }}
        loading={premoveLoading}
        notes={notes}
        onSelect={setSelectedId}
        onNote={writeNote}
        priceWatches={priceWatches}
        onSavePriceWatch={savePriceWatch}
      />

      <PicksPanel
        picks={shownPicks}
        loading={picksLoading}
        notes={notes}
        watchlist={watchlist}
        onSelect={setSelectedId}
        onNote={writeNote}
        onPinTicker={toggleTicker}
        onPinContract={toggleContract}
        onDismiss={dismissRow}
        priceWatches={priceWatches}
        onSavePriceWatch={savePriceWatch}
      />

      <PriceWatchesPanel
        evaluations={
          (watchCheck?.evaluations.filter((row) =>
            priceWatches.some((watch) => watch.id === row.watch.id),
          ) ??
            priceWatches.map(
              (watch): EvaluatedWatch => ({
                watch,
                quote: null,
                status: "ok",
                pctMove: null,
                hint: null,
              }),
            ))
        }
        alerts={(watchCheck?.alerts ?? []).filter((alert) =>
          priceWatches.some((watch) => watch.id === alert.watchId),
        )}
        loading={watchesLoading && priceWatches.length > 0}
        onRemove={removePriceWatch}
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
      ) : shownItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="font-medium">No flow survived these filters</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {watchlistOnly
              ? "Nothing on the tape matches the watchlist. Unpin Watchlist only, or pin another name."
              : data?.warning
                ? data.warning
                : dismissed.length > 0
                ? "Visible tape is empty. Restore dismissed alerts or loosen filters."
                : "No prints in the current US cash session matched these filters. Not filling from older whale floors."}
          </p>
        </div>
      ) : (
        <FlowList
          items={shownItems}
          selectedId={selectedId}
          watchlist={watchlist}
          onSelect={setSelectedId}
          onPinTicker={toggleTicker}
          onDismiss={dismissRow}
          priceWatches={priceWatches}
          onSavePriceWatch={savePriceWatch}
        />
      )}

      <DetailDrawer
        row={selected}
        marketTide={rejectMock ? null : data?.tide ?? null}
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
        priceWatches={priceWatches}
        onSavePriceWatch={savePriceWatch}
      />
    </div>
  );
}
