"use client";

import { useEffect, useState } from "react";
import { CloudLightning, Sun, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RegimeSnapshot, YieldMove } from "@/lib/types";

const POLL_MS = 15 * 60_000;

function fmtYield(y: YieldMove): string {
  if (y.last == null) return `${y.symbol} n/a`;
  const bp = y.changeBp == null ? "" : ` (${y.changeBp >= 0 ? "+" : ""}${y.changeBp.toFixed(1)}bp)`;
  return `${y.symbol} ${y.last.toFixed(2)}%${bp}`;
}

function fmtEventTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export function RegimeBanner() {
  const [regime, setRegime] = useState<RegimeSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/regime", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as RegimeSnapshot;
        if (alive) {
          setRegime(payload);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (!regime) {
    return failed ? (
      <div className="rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
        Macro regime unavailable — lists use normal rules.
      </div>
    ) : null;
  }

  const calm = regime.label === "calm";
  const Icon = calm ? Sun : regime.label === "report-day" ? CloudLightning : TriangleAlert;
  const title =
    regime.label === "report-day" ? "Report day" : regime.label === "risky" ? "Risky macro day" : "Calm macro day";

  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        calm && "border-emerald-400/30 bg-emerald-950/30 text-emerald-50",
        regime.label === "risky" && "border-amber-400/50 bg-amber-950/50 text-amber-50",
        regime.label === "report-day" && "border-orange-400/50 bg-orange-950/50 text-orange-50",
      )}
      data-regime={regime.label}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium tracking-wide">
          <Icon className="size-4" />
          <span>Regime · {title}</span>
        </div>
        <div className="font-mono text-[11px] opacity-90">
          {fmtYield(regime.yields.us10y)} · {fmtYield(regime.yields.us30y)}
          {regime.yields.trend5d?.us30yBp != null
            ? ` · 5d 30Y ${regime.yields.trend5d.us30yBp >= 0 ? "+" : ""}${regime.yields.trend5d.us30yBp.toFixed(0)}bp`
            : ""}
          {regime.tide ? ` · tide ${regime.tide.bias}` : ""}
        </div>
      </div>
      {regime.lockout?.active && regime.lockout.until ? (
        <div className="mt-2 rounded-md border border-rose-400/60 bg-rose-950/70 px-2 py-1 text-xs font-semibold text-rose-50">
          Pre-release lockout ({regime.lockout.event}) — no new picks until {fmtEventTime(regime.lockout.until)} ET.
        </div>
      ) : null}
      {regime.dayRating ? (
        <div className="mt-1 text-xs">
          <span className="font-semibold uppercase tracking-wide">Desk rating: {regime.dayRating.rating}</span>
        </div>
      ) : null}
      <ul className="mt-1 space-y-0.5 text-xs leading-relaxed opacity-90">
        {regime.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {regime.rules.active ? (
        <p className="mt-1 text-xs font-medium">
          Rules on: lists capped at {regime.rules.maxShortlist}, DTE under {regime.rules.minDte} dropped
          {regime.rules.rateTechPenalty < 0
            ? `, long-duration tech calls docked ${regime.rules.rateTechPenalty}`
            : ""}
          {regime.rules.rateSensitivePenalty < 0
            ? `, rate-sensitive calls (XLU/REITs/homebuilders/IWM/KRE/TLT) docked ${regime.rules.rateSensitivePenalty}`
            : ""}
          . Max 2 per issuer (GOOG+GOOGL = one), 3 per sector.
        </p>
      ) : (
        <p className="mt-1 text-xs opacity-80">
          Normal list sizes. Max 2 per issuer (GOOG+GOOGL = one), 3 per sector.
          {regime.rules.rateTechPenalty < 0 ? ` Long-duration tech calls docked ${regime.rules.rateTechPenalty} (yields rising).` : ""}
        </p>
      )}
      {regime.events.today.length > 0 || regime.events.upcoming.length > 0 ? (
        <div className="mt-1 font-mono text-[10px] opacity-80">
          {regime.events.today.length > 0
            ? `Today: ${regime.events.today.map((e) => `${fmtEventTime(e.date)} ${e.title}${e.impact === "High" ? "*" : ""}`).join(" · ")}`
            : ""}
          {regime.events.upcoming.length > 0
            ? `${regime.events.today.length > 0 ? " | " : ""}Next: ${regime.events.upcoming
                .slice(0, 3)
                .map((e) => `${fmtEventTime(e.date)} ${e.title}`)
                .join(" · ")}`
            : ""}
        </div>
      ) : null}
      <p className="mt-1 text-[10px] opacity-60">Options-flow context only, not financial advice. ET times.</p>
    </div>
  );
}
