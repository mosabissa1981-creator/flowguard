"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BriefDoc, ReleaseReadDoc, ShadowCandidate, ShadowModuleId, ShadowVerdict } from "@/lib/shadow/types";

const POLL_MS = 15 * 60_000;

type ShadowView = {
  day: string;
  note: string;
  updatedAt: string;
  candidates: ShadowCandidate[];
  verdicts: Record<string, ShadowVerdict[]>;
  moduleOrder: ShadowModuleId[];
  dayNotes: { regime_analogs?: { note?: string } };
  llm: { status: string; spendUsd: number; nextAllowedAt: string | null; lastError?: string };
  uwCalls: number;
};

const SHORT: Record<ShadowModuleId, string> = {
  news_x_check: "News",
  x_sentiment_shift: "X",
  earnings_check: "Earn",
  same_buyer_tracking: "Repeat",
  worth_the_price: "Price",
  regime_analogs: "Analog",
  adaptive_exits: "Exits",
  debate: "Debate",
};

const CELL: Record<ShadowVerdict["verdict"], string> = {
  boost: "bg-emerald-500/20 text-emerald-200",
  flag: "bg-rose-500/20 text-rose-200",
  pass: "bg-zinc-500/10 text-zinc-300",
  skip: "text-zinc-600",
};
const GLYPH: Record<ShadowVerdict["verdict"], string> = { boost: "▲", flag: "▼", pass: "·", skip: "–" };

type SideCols = {
  gap: Record<string, { verdict: string; reasons?: string[] }>;
  ft: Record<string, { byWindow: Record<string, string> }>;
};

/** Gap-chase + follow-through shadow columns (TEST only; fetched after the board loads). */
function useSideCols(): SideCols {
  const [cols, setCols] = useState<SideCols>({ gap: {}, ft: {} });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [g, f] = await Promise.all([
          fetch("/api/shadow/gap-chase", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetch("/api/shadow/follow-through", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (alive) setCols({ gap: g?.rows ?? {}, ft: f?.rows ?? {} });
      } catch {
        // shadow only
      }
    };
    const first = setTimeout(() => void load(), 6000);
    const id = setInterval(() => void load(), 3 * 60_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return cols;
}

const FT_GLYPH: Record<string, string> = { contract: "✓✓", ticker: "✓", none: "✗", pending: "…" };

export function ShadowPanel() {
  const side = useSideCols();
  const [data, setData] = useState<ShadowView | null>(null);
  const [brief, setBrief] = useState<BriefDoc | null>(null);
  const [reads, setReads] = useState<ReleaseReadDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const get = async <T,>(url: string): Promise<T | null> => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        return r.ok ? ((await r.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [s, b, rr] = await Promise.all([
      get<ShadowView>("/api/shadow"),
      get<BriefDoc>("/api/brief"),
      get<ReleaseReadDoc>("/api/release-read"),
    ]);
    if (s) setData(s);
    else setError("shadow unavailable");
    setBrief(b);
    setReads(rr);
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  const order = data?.moduleOrder ?? (Object.keys(SHORT) as ShadowModuleId[]);
  const cands = Array.isArray(data?.candidates) ? data.candidates : [];

  return (
    <section className="rounded-xl border border-amber-400/20 bg-card/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="size-4 text-amber-300" />
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-200/80">Shadow signals</span>
          <span className="text-[10px] text-muted-foreground">logged for the study book · do not change picks</span>
        </div>
        {data ? (
          <div className="flex items-center gap-1.5 text-[10px]">
            <Badge className="rounded-md bg-amber-500/10 text-amber-200">LLM {data.llm?.status ?? "—"}</Badge>
            <Badge className="rounded-md bg-amber-500/10 text-amber-200">${Number(data.llm?.spendUsd ?? 0).toFixed(2)} today</Badge>
            <Badge className="rounded-md bg-amber-500/10 text-amber-200">UW {data.uwCalls}</Badge>
          </div>
        ) : null}
      </div>

      {brief?.brief ? (
        <p className="mb-2 text-xs leading-relaxed">
          <span className="font-medium text-amber-200">Brief ({brief.brief.riskTone}):</span> {brief.brief.summary}
        </p>
      ) : null}
      {(Array.isArray(reads?.reads) ? reads.reads : []).filter((r) => r.read).map((r) => (
        <p key={r.event} className="mb-1 text-xs">
          <span
            className={cn(
              "mr-1 rounded px-1 font-medium",
              r.read?.temperature === "hot" ? "bg-rose-500/20 text-rose-200" : r.read?.temperature === "cool" ? "bg-sky-500/20 text-sky-200" : "bg-zinc-500/20",
            )}
          >
            {r.read?.temperature}
          </span>
          <span className="font-medium">{r.event}:</span> {r.read?.headline}
        </p>
      ))}

      {error && !data ? <p className="text-xs text-rose-300">{error}</p> : null}
      {data && cands.length === 0 ? <p className="text-xs text-muted-foreground">No finalists annotated yet today.</p> : null}
      {cands.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-0.5 font-mono text-[11px]">
            <thead>
              <tr className="text-[10px] text-muted-foreground">
                <th className="pr-2 text-left font-normal">Contract</th>
                {order.map((m) => (
                  <th key={m} className="px-1 text-center font-normal">
                    {SHORT[m]}
                  </th>
                ))}
                <th className="px-1 text-center font-normal" title="Gap-up chase check (TEST)">Gap</th>
                <th className="px-1 text-center font-normal" title="Follow-through within 30 min (TEST): ✓✓ same contract, ✓ ticker, ✗ none">FT</th>
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => {
                const vs = data?.verdicts?.[c.contract] ?? [];
                return (
                  <tr key={c.contract}>
                    <td className="whitespace-nowrap pr-2">
                      {c.ticker} {c.strike}
                      {c.side === "call" ? "C" : "P"} {c.expiry?.slice(5)}
                    </td>
                    {order.map((m) => {
                      const v = vs.find((x) => x.module === m);
                      return (
                        <td key={m} className="px-0.5 text-center">
                          <span
                            title={v ? `${SHORT[m]} ${v.verdict.toUpperCase()} (${v.confidence}): ${v.reason}` : "not run"}
                            className={cn("inline-block min-w-6 cursor-help rounded px-1", v ? CELL[v.verdict] : "text-zinc-700")}
                          >
                            {v ? GLYPH[v.verdict] : " "}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-0.5 text-center">
                      <GapCell g={side.gap[c.contract]} />
                    </td>
                    <td className="px-0.5 text-center">
                      <FtCell st={side.ft[c.contract]?.byWindow?.["30m"]} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {data?.dayNotes?.regime_analogs?.note ? (
        <p className="mt-1 text-[10px] text-muted-foreground">Analogs: {data.dayNotes?.regime_analogs?.note}</p>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">▲ boost · ▼ flag · · pass · – skip. Hover a cell for the reason. Full JSON: /api/shadow</p>
    </section>
  );
}

function GapCell({ g }: { g?: { verdict: string; reasons?: string[] } }) {
  if (!g) return <span className="text-zinc-700"> </span>;
  return (
    <span
      title={g.reasons?.join("; ") || g.verdict}
      className={cn("inline-block min-w-6 cursor-help rounded px-1", g.verdict === "flag" ? "bg-orange-500/20 text-orange-200" : "text-zinc-500")}
    >
      {g.verdict === "flag" ? "⚑" : "ok"}
    </span>
  );
}

function FtCell({ st }: { st?: string }) {
  return (
    <span
      title={st ? `follow-through 30m: ${st}` : "not tracked"}
      className={cn(
        "inline-block min-w-6 cursor-help rounded px-1",
        st === "contract" || st === "ticker" ? "text-emerald-300" : st === "none" ? "text-zinc-400" : "text-zinc-700",
      )}
    >
      {st ? (FT_GLYPH[st] ?? st) : " "}
    </span>
  );
}
