"use client";

import { Bell, BellOff, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { contractLabel } from "@/lib/price-watches";
import { formatPrice, formatSignedPct } from "@/lib/format";
import type { EvaluatedWatch, PriceWatch, PriceWatchStatus, WatchAlert, WatchDataQuality } from "@/lib/types";

function statusTone(status: PriceWatchStatus) {
  if (status === "adverse") return "bg-rose-500/15 text-rose-300";
  if (status === "approaching") return "bg-amber-500/15 text-amber-200";
  return "bg-emerald-500/15 text-emerald-300";
}

function qualityLabel(quality: WatchDataQuality) {
  if (quality === "uw_last") return "UW last";
  if (quality === "uw_nbbo") return "UW NBBO";
  return "Last flow print";
}

function armingSourceLabel(source: PriceWatch["referenceSource"]) {
  if (source === "uw_last") return "armed at live UW last";
  if (source === "uw_nbbo") return "armed at live UW mid";
  if (source === "session_print") return "armed at last session print";
  if (source === "alert") return "armed at alert print";
  return null;
}

export function PriceWatchesPanel({
  evaluations,
  alerts,
  loading,
  onRemove,
}: {
  evaluations: EvaluatedWatch[];
  alerts: WatchAlert[];
  loading: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <section className="rounded-xl border border-sky-400/20 bg-card/80 p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-200/80">
            Manager · My watches
          </div>
          <h2 className="font-medium">Options price alerts — no auto-trading</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Track a fill for adverse moves, or watch a pick until premium approaches entry. Quotes
            prefer Unusual Whales last/NBBO; otherwise the last flow print.
          </p>
        </div>
        <Badge className="rounded-md bg-sky-500/15 text-sky-200">
          {evaluations.length} watch{evaluations.length === 1 ? "" : "es"}
        </Badge>
      </div>

      {alerts.length > 0 ? (
        <div className="mb-3 space-y-2">
          {alerts.map((alert) => (
            <div
              key={alert.watchId}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                alert.type === "adverse"
                  ? "border-rose-500/30 bg-rose-500/10"
                  : "border-amber-400/30 bg-amber-400/10",
              )}
            >
              <div className="flex items-start gap-2">
                <Bell className="mt-0.5 size-4 shrink-0" />
                <div>
                  <div className="font-medium">
                    {alert.contract} · {alert.hint}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Last {formatPrice(alert.last)} vs {formatPrice(alert.reference)} (
                    {formatSignedPct(alert.pctMove)}) · {qualityLabel(alert.dataQuality)} · not a
                    trade ticket
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {loading && evaluations.length === 0 ? (
        <p className="text-sm text-muted-foreground">Checking live option premiums…</p>
      ) : evaluations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No price watches yet. On a pick, tap Track entry (you bought it) or Watch for entry (not
          in yet).
        </p>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {evaluations.map((row) => {
            const { watch, quote, status, pctMove, hint } = row;
            return (
              <article
                key={watch.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/40 p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{watch.ticker}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {contractLabel(watch)}
                    </span>
                    <Badge className={cn("rounded-md text-[10px] uppercase", statusTone(status))}>
                      {status}
                    </Badge>
                    <Badge className="rounded-md bg-muted text-[10px] uppercase text-muted-foreground">
                      {watch.kind === "adverse" ? "Position" : "Entry"}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-xs text-amber-200">
                    Last {quote ? formatPrice(quote.last) : "—"} ·{" "}
                    {watch.kind === "adverse" ? "entry" : "target"}{" "}
                    {formatPrice(watch.referencePremium)}
                    {pctMove != null ? ` · ${formatSignedPct(pctMove)}` : ""}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {quote ? qualityLabel(quote.quality) : "No quote yet"}
                    {armingSourceLabel(watch.referenceSource) ? ` · ${armingSourceLabel(watch.referenceSource)}` : ""}
                    {watch.kind === "adverse"
                      ? ` · cut if down ${Math.round(watch.adversePct * 100)}%${watch.stopPremium ? ` or ≤ ${formatPrice(watch.stopPremium)}` : ""}`
                      : ` · within ${Math.round(watch.approachPct * 100)}% of target`}
                    {hint ? ` · ${hint}` : ""}
                  </p>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove watch ${watch.ticker}`}
                  onClick={() => onRemove(watch.id)}
                >
                  {status === "ok" ? <X /> : <BellOff />}
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
