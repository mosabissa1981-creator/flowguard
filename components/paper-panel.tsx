"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatExpiry, formatStrike } from "@/lib/format";
import type { BookStats, PaperClosed, PaperPosition } from "@/lib/paper-core";
import type { PaperView } from "@/lib/paper";

type AiPanel = NonNullable<PaperView["aiTrader"]>;

const POLL_MS = 5 * 60_000;

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (n: number) => (n > 0 ? "text-emerald-300" : n < 0 ? "text-rose-300" : "text-muted-foreground");

const AI_BOOKS = new Set(["ai-grok", "ai-claude", "ai-gpt", "ai-rules"]);

const SOURCE: Record<string, string> = {
  "ai-pick": "Pick",
  premove: "Premove",
  grok: "Grok",
  claude: "Claude",
  gpt: "GPT",
  rules: "Rules",
  lottery: "Lottery",
  puts: "Puts",
  "earnings-calendar": "Earn cal",
  "calls-earnings-runup": "Earn run-up",
  "calls-breakout": "Breakout",
  "calls-sector-wave": "Sector wave",
  "puts-earnings-rundown": "Earn run-down",
  "puts-breakdown": "Breakdown",
  "puts-sector-selloff": "Sector selloff",
};

function contractLabel(p: PaperPosition) {
  if (p.side === "spread") return `${p.ticker} spread ${formatExpiry(p.expiry)}`;
  return `${p.ticker} ${p.strike != null ? formatStrike(p.strike) : ""}${p.side === "call" ? "C" : "P"} ${formatExpiry(p.expiry)}`;
}

function clockCT(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
}

function OpenRow({ p }: { p: PaperPosition }) {
  const mark = p.lastMark?.value ?? null;
  const pnl = mark != null ? Math.round((mark * 100 * p.qty - p.costUsd) * 100) / 100 : null;
  return (
    <li className="rounded-lg border border-border/70 bg-background/40 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 font-mono text-sm font-semibold">
          {contractLabel(p)}
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">{SOURCE[p.source] ?? p.source}</span>
        </div>
        <span className={cn("shrink-0 font-mono text-sm", pnl == null ? "text-muted-foreground" : tone(pnl))}>{pnl == null ? "no mark yet" : signed(pnl)}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        {p.qty}× @ ${p.entryPrice.toFixed(2)} ({p.entryBasis === "uw_ask" || p.entryBasis === "uw_net" ? "live ask" : "alert +5%"}) · cost {money(p.costUsd)}
        {mark != null ? ` · bid $${mark.toFixed(2)}` : ""}
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        target {p.target != null ? `$${p.target.toFixed(2)}` : "—"} · stop {p.stop != null ? `$${p.stop.toFixed(2)}` : "none"} · time stop {p.timeStopAt ? clockCT(p.timeStopAt) : `${p.timeStopDate} 2:30 PM CT`}
      </div>
      {p.drivenBy ? <div className="font-mono text-[10px] text-sky-200/80">source {p.drivenBy}{p.drivenByWhy ? ` · ${p.drivenByWhy}` : ""}</div> : null}
    </li>
  );
}

function ClosedRow({ c }: { c: PaperClosed }) {
  return (
    <li className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 last:border-0">
      <div className="min-w-0">
        <div className="truncate font-mono text-xs">{contractLabel(c)}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {c.exitReason} · ${c.entryPrice.toFixed(2)} → ${c.exitPrice.toFixed(2)} · {clockCT(c.exitedAt)}
        </div>
      </div>
      <div className={cn("shrink-0 text-right font-mono text-xs", tone(c.pnlUsd))}>
        {signed(c.pnlUsd)}
        <div className="text-[10px]">{c.pnlPct > 0 ? "+" : ""}{c.pnlPct.toFixed(1)}%</div>
      </div>
    </li>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg bg-background/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-base font-semibold", className)}>{value}</div>
    </div>
  );
}

function BookTable({ books }: { books: BookStats[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">Book</th>
            <th className="py-1 text-right font-normal">Equity</th>
            <th className="py-1 text-right font-normal">Total</th>
            <th className="py-1 text-right font-normal">W–L</th>
            <th className="py-1 text-right font-normal">Open</th>
          </tr>
        </thead>
        <tbody>
          {books.map((b) => (
            <tr key={b.book} className="border-t border-border/40">
              <td className="py-1 pr-2">{b.label.replace(" · test", "")}</td>
              <td className="py-1 text-right">{money(b.equity)}</td>
              <td className={cn("py-1 text-right", tone(b.pnlTotalUsd))}>{signed(b.pnlTotalUsd)}</td>
              <td className="py-1 text-right">{b.wins}–{b.losses}</td>
              <td className="py-1 text-right">{b.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AiTraderBlock({ panel, books, open, closed }: { panel: AiPanel | null; books: BookStats[]; open: PaperPosition[]; closed: PaperClosed[] }) {
  const week = panel?.week ?? null;
  const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
  return (
    <div className="mt-3 rounded-lg border border-sky-400/30 bg-sky-500/5 p-2.5">
      <div className="mb-1 text-[11px] font-medium text-sky-100">AI trader books</div>
      <p className="text-[11px] text-muted-foreground">
        Main source: {panel?.mainSource ?? "rules"}
        {panel?.mainSourceWhy ? ` · ${panel.mainSourceWhy}` : ""}. Each book paper-fills only its own takes from the shared wide pool, after the quality floor
        (spread ≤ 4%, ask ≥ $2, premium ≥ $100k, score ≥ 90). Friday score picks the next week's main source.
      </p>
      {books.length > 0 ? <div className="mt-2"><BookTable books={books} /></div> : null}
      {week ? (
        <div className="mt-2">
          <div className="text-[11px] text-sky-100">
            Week ending {week.weekEnd}: {week.winner ? `${week.winner} wins` : "no winner"}. {week.winnerReason}
          </div>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full font-mono text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">Book</th>
                  <th className="py-1 text-right font-normal">Trades</th>
                  <th className="py-1 text-right font-normal">Win</th>
                  <th className="py-1 text-right font-normal">Avg</th>
                  <th className="py-1 text-right font-normal">P&L</th>
                  <th className="py-1 text-right font-normal">Take</th>
                  <th className="py-1 text-right font-normal">Pass</th>
                </tr>
              </thead>
              <tbody>
                {week.books.map((b) => (
                  <tr key={b.book} className="border-t border-border/40">
                    <td className="py-1 pr-2">{b.label}</td>
                    <td className="py-1 text-right">{b.trades}</td>
                    <td className="py-1 text-right">{b.winRatePct == null ? "—" : `${b.winRatePct}%`}</td>
                    <td className={cn("py-1 text-right", tone(b.avgReturnPct ?? 0))}>{pct(b.avgReturnPct)}</td>
                    <td className={cn("py-1 text-right", tone(b.totalPnlUsd))}>{signed(b.totalPnlUsd)}</td>
                    <td className="py-1 text-right">{pct(b.takeAvgPct)}</td>
                    <td className="py-1 text-right">{pct(b.passAvgPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {week.studyWritten ? `Written to ${week.studyMd}` : `Shown here. Writes ${week.studyJson} when the process can save files.`}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No Friday score yet. Week 1 starts {panel?.week1Monday ?? "2026-11-16"}. Until a score names a winner, main follows the rules-only book.
        </p>
      )}
      {open.length > 0 ? (
        <ul className="mt-2 grid gap-2 lg:grid-cols-2">
          {open.map((p) => (
            <OpenRow key={p.id} p={p} />
          ))}
        </ul>
      ) : null}
      {closed.length > 0 ? (
        <ul className="mt-2">
          {closed.map((c) => (
            <ClosedRow key={`${c.id}:${c.exitedAt}`} c={c} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PaperPanel() {
  const [data, setData] = useState<PaperView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/paper", { cache: "no-store" });
      const json = (await r.json()) as PaperView & { error?: string };
      if (!r.ok || json.error) throw new Error(json.error ?? `HTTP ${r.status}`);
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const h = data?.headline;
  const mainOpen = (data?.open ?? []).filter((p) => p.book === "main");
  const aiOpen = (data?.open ?? []).filter((p) => AI_BOOKS.has(p.book));
  const testOpen = (data?.open ?? []).filter((p) => p.book !== "main" && !AI_BOOKS.has(p.book));
  const aiStats = (data?.books ?? []).filter((b) => AI_BOOKS.has(b.book));
  const testStats = (data?.books ?? []).filter((b) => b.book !== "main" && !AI_BOOKS.has(b.book));

  return (
    <section className="rounded-xl border border-dashed border-sky-400/40 bg-card/50 p-3 sm:p-4" aria-label="Paper account">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-sky-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-200/80">Paper account</span>
        </div>
        <Badge className="rounded-md bg-sky-500/15 text-sky-200">test mode · fake money</Badge>
      </div>
      <p className="mb-3 rounded-md bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-100">
        Paper / test mode, not real money, not financial advice.
      </p>

      {!data && !error ? <p className="text-sm text-muted-foreground">Loading paper account…</p> : null}
      {error && !data ? <p className="text-sm text-rose-300">Paper account unavailable ({error}).</p> : null}

      {h ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Balance" value={money(h.equity)} />
            <Stat label="P&L today" value={signed(h.pnlTodayUsd)} className={tone(h.pnlTodayUsd)} />
            <Stat label="P&L total" value={`${signed(h.pnlTotalUsd)} (${h.pnlTotalPct > 0 ? "+" : ""}${h.pnlTotalPct.toFixed(1)}%)`} className={tone(h.pnlTotalUsd)} />
            <Stat label="Win rate" value={h.winRatePct == null ? "—" : `${h.winRatePct}% (${h.wins}–${h.losses})`} />
          </div>
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            Cash {money(h.balance)} · open cost {money(h.openCostUsd)} · started {clockCT(data!.startedAt)} with $10,000
          </p>

          <div className="mt-3">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Open positions ({mainOpen.length})</div>
            {mainOpen.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None. Main follows {data?.aiTrader?.mainSource ?? "the rules-only book"}
                {data?.aiTrader?.mainSourceWhy ? ` (${data.aiTrader.mainSourceWhy})` : ""}. Premove still fills here. Grok AI-picks takes do not.
              </p>
            ) : (
              <ul className="grid gap-2 lg:grid-cols-2">
                {mainOpen.map((p) => (
                  <OpenRow key={p.id} p={p} />
                ))}
              </ul>
            )}
          </div>

          <details className="mt-3 group">
            <summary className="cursor-pointer select-none py-1 text-[11px] font-medium text-muted-foreground">
              Last 10 closed ({data!.closed.length})
            </summary>
            {data!.closed.length === 0 ? (
              <p className="text-xs text-muted-foreground">No closed trades yet.</p>
            ) : (
              <ul>
                {data!.closed.map((c) => (
                  <ClosedRow key={`${c.id}:${c.exitedAt}`} c={c} />
                ))}
              </ul>
            )}
          </details>

          <AiTraderBlock panel={data!.aiTrader} books={aiStats} open={aiOpen} closed={data!.closedAi ?? []} />

          <details className="mt-1">
            <summary className="cursor-pointer select-none py-1 text-[11px] font-medium text-muted-foreground">
              Test lanes, separate books ({testOpen.length} open)
            </summary>
            <BookTable books={testStats} />
            {testOpen.length > 0 ? (
              <ul className="mt-2 grid gap-2 lg:grid-cols-2">
                {testOpen.map((p) => (
                  <OpenRow key={p.id} p={p} />
                ))}
              </ul>
            ) : null}
            {data!.closedTest.length > 0 ? (
              <ul className="mt-2">
                {data!.closedTest.map((c) => (
                  <ClosedRow key={`${c.id}:${c.exitedAt}`} c={c} />
                ))}
              </ul>
            ) : null}
          </details>

          {data!.tracking && (data!.tracking.open.length > 0 || data!.tracking.closed.length > 0) ? (
            <details className="mt-1">
              <summary className="cursor-pointer select-none py-1 text-[11px] font-medium text-amber-200/80">
                Tracking only · skipped by 5% rule ({data!.tracking.open.length} open, {data!.tracking.stats.closed} closed, would-be P&amp;L $
                {data!.tracking.stats.pnlUsd.toFixed(0)})
              </summary>
              <p className="text-[10px] text-muted-foreground">{data!.tracking.label}</p>
              <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {data!.tracking.open.map((p) => (
                  <li key={p.id}>
                    {p.contract} [{p.source}] in {p.entryPrice.toFixed(2)} · mark {(p.lastMark?.value ?? p.entryPrice).toFixed(2)}
                  </li>
                ))}
                {data!.tracking.closed.map((c) => (
                  <li key={`${c.id}-${c.exitedAt}`}>
                    {c.contract} [{c.source}] {c.exitReason} {c.pnlPct >= 0 ? "+" : ""}
                    {c.pnlPct.toFixed(1)}% (${c.pnlUsd.toFixed(0)})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <details className="mt-1">
            <summary className="cursor-pointer select-none py-1 text-[11px] font-medium text-muted-foreground">How it works</summary>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
              {data!.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {data!.skips.length > 0 ? <li>Last skip: {data!.skips[0].contract} ({data!.skips[0].reason})</li> : null}
            </ul>
          </details>

          <p className="mt-2 text-[10px] text-muted-foreground">
            Updated {clockCT(data!.lastTickAt)} · UW quote calls today {data!.uw.quoteCalls}/{data!.uw.cap} · {data!.disclaimer}
          </p>
        </>
      ) : null}
    </section>
  );
}
