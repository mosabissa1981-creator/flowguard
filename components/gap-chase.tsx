"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** TEST / SHADOW gap-up chase checker — client side. Flags only; never filters or re-ranks live picks. */

type Verdict = "flag" | "pass" | "n/a";
type Row = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  lists: string[];
  verdict: Verdict;
  firstVerdict: Verdict;
  penalty: number;
  reasons: string[];
  stockPctAtPrint: number | null;
  confirmation: "2nd-ask" | "pullback" | null;
  firstPrintUtc: string | null;
  firstSeenAt: string;
  alertPrice: number | null;
};
type View = {
  day: string;
  updatedAt: string;
  disclaimer: string;
  rule: string;
  backtest: string;
  market: { spyGapPct: number | null; qqqGapPct: number | null; gapDay: boolean; gapDownDay?: boolean; capturedAt: string | null };
  rows: Record<string, Row>;
  log: Array<{ at: string; contract: string; from: string | null; to: string; why: string }>;
  uwCalls: number;
  error?: string;
};

const POLL_MS = 3 * 60_000;
const Ctx = createContext<{ view: View | null; reload: () => void }>({ view: null, reload: () => undefined });

export function GapChaseProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/shadow/gap-chase", { cache: "no-store" });
      if (r.ok) setView((await r.json()) as View);
    } catch {
      // Shadow only — ignore.
    }
  }, []);
  useEffect(() => {
    // Defer the first load so it never competes with the live board fetches.
    const first = setTimeout(() => void reload(), 4000);
    const id = setInterval(() => void reload(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [reload]);
  const value = useMemo(() => ({ view, reload: () => void reload() }), [view, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const pct = (v: number | null | undefined) => (v == null ? "?" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

/** Small TEST flag next to a pick. Renders nothing unless the checker flagged the contract. */
export function GapChaseBadge({ contract }: { contract?: string | null }) {
  const { view } = useContext(Ctx);
  const row = contract ? view?.rows?.[contract] : undefined;
  if (!row || row.verdict !== "flag") return null;
  return (
    <Badge
      title={`TEST / shadow only — not applied to this pick.\n${row.reasons.join("\n")}`}
      className="rounded-md border border-dashed border-orange-400/50 bg-orange-500/10 font-mono text-[10px] uppercase text-orange-200"
    >
      test · {row.side === "put" ? "gap-down put chase" : "gap-up chase"}{row.penalty ? ` ${row.penalty}` : ""}
    </Badge>
  );
}

export function GapChasePanel() {
  const { view } = useContext(Ctx);
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () =>
      Object.values(view?.rows ?? {})
        .filter((r) => r.side === "call" || r.side === "put")
        .sort((a, b) => (a.verdict === b.verdict ? (a.firstSeenAt < b.firstSeenAt ? -1 : 1) : a.verdict === "flag" ? -1 : 1)),
    [view],
  );
  if (!view) return null;
  const flagged = rows.filter((r) => r.verdict === "flag").length;
  const m = view.market;
  return (
    <section className="rounded-xl border border-dashed border-orange-400/30 bg-card/60 p-4">
      <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.2em] text-orange-200/80">
            <FlaskConical className="size-3" /> Test · shadow checker
          </div>
          <h2 className="font-medium">Gap chase check (calls on gap-ups, puts on gap-downs)</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.capturedAt
              ? `SPY ${pct(m.spyGapPct)} / QQQ ${pct(m.qqqGapPct)} at the open — ${m.gapDay ? "gap-up day: morning calls need a 2nd ask print or a pullback" : m.gapDownDay ?? Math.min(m.spyGapPct ?? 1, m.qqqGapPct ?? 1) <= -0.003 ? "gap-down day: morning puts on names already down 1–3% are flagged" : "no gap today"}.`
              : "Market gap not captured yet (runs in market hours)."}{" "}
            Flags only; live picks are unchanged.
          </p>
        </div>
        <Badge className={cn("rounded-md", flagged ? "bg-orange-500/15 text-orange-200" : "bg-zinc-500/15 text-zinc-300")}>
          {flagged} flagged / {rows.length} picks
        </Badge>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 text-xs">
          <p className="text-muted-foreground">{view.rule}</p>
          <p className="text-muted-foreground">Backtest: {view.backtest}</p>
          {rows.length === 0 ? (
            <p className="text-muted-foreground">No picks checked yet today.</p>
          ) : (
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.contract} className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={cn(
                      "rounded px-1 font-mono text-[10px] uppercase",
                      r.verdict === "flag" ? "bg-orange-500/20 text-orange-200" : "bg-zinc-500/10 text-zinc-300",
                    )}
                  >
                    {r.verdict}
                  </span>
                  <span className="font-mono">{r.contract}</span>
                  <span className="text-muted-foreground">
                    {r.lists.join(", ")} · stock {pct(r.stockPctAtPrint)} at print
                    {r.confirmation ? ` · confirmed (${r.confirmation})` : ""}
                    {r.firstVerdict !== r.verdict ? ` · first ${r.firstVerdict}` : ""}
                  </span>
                  <span className="w-full pl-10 text-muted-foreground">{r.reasons[r.reasons.length - 1]}</span>
                </li>
              ))}
            </ul>
          )}
          {view.log.length ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Change log ({view.log.length})</summary>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {view.log
                  .slice(-40)
                  .reverse()
                  .map((l, i) => (
                    <li key={`${l.at}-${l.contract}-${i}`}>
                      {new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {l.contract}: {l.from ?? "new"} → {l.to} — {l.why}
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
          <p className="text-[10px] text-muted-foreground">{view.disclaimer}</p>
        </div>
      ) : null}
    </section>
  );
}
