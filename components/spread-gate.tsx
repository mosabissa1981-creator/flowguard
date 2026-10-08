"use client";

import { Badge } from "@/components/ui/badge";
import { SPREAD_MAX_PCT, type SpreadInfo, type SpreadSkip } from "@/lib/spread-core";
import { cn } from "@/lib/utils";

/** LIVE spread gate (client): per-pick spread tag + the skipped list ("Skipped: wide spread X%" / single-stock put). */

function pctText(pct: number | null | undefined): string {
  return pct == null ? "?" : `${Math.round(pct * 100)}%`;
}

function money(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

export function SpreadBadge({ spread, testOnly }: { spread?: SpreadInfo | null; testOnly?: boolean }) {
  if (!spread) return null;
  const title =
    spread.status === "unknown"
      ? "Spread unknown: no bid/ask from UW or the flow alert. Kept, not filtered."
      : `Bid ${money(spread.bid)} / ask ${money(spread.ask)} → spread ${pctText(spread.pct)} of mid (${spread.source === "uw_nbbo" ? "live UW NBBO" : "flow alert NBBO"}). Rule: over ${Math.round(SPREAD_MAX_PCT * 100)}% is skipped${testOnly ? " (test lane: flag only)" : ""}.`;
  return (
    <Badge
      title={title}
      className={cn(
        "rounded-md font-mono text-[10px]",
        spread.status === "unknown"
          ? "bg-amber-500/15 text-amber-200"
          : spread.status === "wide"
            ? "bg-rose-500/15 text-rose-300"
            : "bg-muted text-muted-foreground",
      )}
    >
      {spread.status === "unknown" ? "spread unknown" : `spread ${pctText(spread.pct)}${spread.status === "wide" && testOnly ? " · wide (test)" : ""}`}
    </Badge>
  );
}

export function SpreadSkips({ skips, className }: { skips?: SpreadSkip[] | null; className?: string }) {
  const rows = Array.isArray(skips) ? skips : [];
  if (rows.length === 0) return null;
  const head = rows.slice(0, 6);
  const rest = rows.slice(6);
  const line = (s: SpreadSkip) => (
    <li key={`${s.list ?? ""}:${s.option_chain}`} title={s.rule === "puts" ? "Live rule: puts only on ETFs / indexes. Still logged in test mode." : `Bid ${money(s.spread?.bid)} / ask ${money(s.spread?.ask)} (${s.spread?.source === "uw_nbbo" ? "live UW NBBO" : "flow alert NBBO"})`}>
      <span className="font-mono text-foreground/80">{s.ticker}</span>{" "}
      <span className="font-mono">{s.option_chain}</span> — {s.reason}
    </li>
  );
  return (
    <div className={cn("mt-3 rounded-md border border-rose-400/20 bg-rose-500/5 px-2 py-1.5 text-xs text-muted-foreground", className)}>
      <div className="text-[10px] uppercase tracking-[0.16em] text-rose-300/80">
        {rows.some((s) => s.rule === "puts")
          ? `Skipped · live rules (spread over ${Math.round(SPREAD_MAX_PCT * 100)}% of mid; ETF/index puts only)`
          : `Skipped · wide spread (over ${Math.round(SPREAD_MAX_PCT * 100)}% of mid)`}
      </div>
      <ul className="mt-1 space-y-0.5">{head.map(line)}</ul>
      {rest.length > 0 ? (
        <details>
          <summary className="cursor-pointer">+{rest.length} more</summary>
          <ul className="mt-1 space-y-0.5">{rest.map(line)}</ul>
        </details>
      ) : null}
    </div>
  );
}
