"use client";

import { useEffect, useState } from "react";

type Usage = {
  day: string;
  tokenCount: number | null;
  ceiling: number;
  jobsStopAt: number;
  byJob: Record<string, number>;
  otherOrBox: number | null;
};
type FadeRow = {
  id: string;
  contract: string;
  source: string;
  pnlPct: number | null;
  bidShare: number | null;
  warning: boolean;
  firstWarningAt: string | null;
  firstWarningSignals: string[];
};
type Fade = { note: string | null; updatedAt: string; rows: Record<string, FadeRow> };
type Hit = { key: string; at: string; contract: string; deltaAsk: number; askShareOfDelta: number; midAtHit: number; maxGainPct: number | null };
type Chain = { note: string | null; tickers: string[]; scans: number; hits: Hit[] };

const fmtT = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v}%`;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** TEST / SHADOW card: UW usage meter, early fade warnings and whole-chain "building" hits. Display only. */
export function IntradayShadowPanel() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [fade, setFade] = useState<Fade | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = async () => {
      const [u, f, c] = await Promise.all([getJson<Usage>("/api/uw-usage"), getJson<Fade>("/api/shadow/fade-watch"), getJson<Chain>("/api/shadow/chain-scan")]);
      setUsage(u);
      setFade(f);
      setChain(c);
    };
    // Deferred so it never competes with the live board fetches.
    const first = setTimeout(() => void load(), 8000);
    const id = setInterval(() => void load(), 3 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  if (!usage && !fade && !chain) return null;
  const fadeRows = Object.values(fade?.rows ?? {});
  const warned = fadeRows.filter((r) => r.firstWarningAt);
  const hits = [...(chain?.hits ?? [])].reverse();
  return (
    <section className="rounded-xl border border-dashed border-sky-400/30 bg-card/60 p-4 text-xs">
      <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-sky-200/80">Test · intraday shadow monitors</div>
          <div className="mt-1 text-muted-foreground">
            Fade warnings {warned.length}/{fadeRows.length} watched · chain hits {hits.length} · UW today{" "}
            {usage?.tokenCount != null ? usage.tokenCount.toLocaleString() : "?"} / {(usage?.ceiling ?? 37_500).toLocaleString()} (new jobs stop at{" "}
            {(usage?.jobsStopAt ?? 35_000).toLocaleString()})
          </div>
        </div>
        <span className="text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">Logged only — never changes live picks, the AI review or paper fills. Not financial advice.</p>
          <div>
            <div className="font-medium">UW calls by job ({usage?.day ?? "?"})</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {Object.entries(usage?.byJob ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k} ${v.toLocaleString()}`)
                .join(" · ") || "none yet"}
              {usage?.otherOrBox != null ? ` · box/other ${usage.otherOrBox.toLocaleString()}` : ""}
            </div>
          </div>
          <div>
            <div className="font-medium">Fade-watch {fade?.note ? `(${fade.note})` : `· updated ${fmtT(fade?.updatedAt)}`}</div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {fadeRows.slice(0, 30).map((r) => (
                <li key={r.id} className={r.warning ? "text-red-300" : r.firstWarningAt ? "text-orange-200" : "text-muted-foreground"}>
                  {r.contract} [{r.source}] {r.pnlPct != null ? signed(r.pnlPct) : "?"} · bid {Math.round((r.bidShare ?? 0) * 100)}%
                  {r.firstWarningAt ? ` · ⚠ ${fmtT(r.firstWarningAt)} ${r.firstWarningSignals.join("+")}` : ""}
                </li>
              ))}
              {fadeRows.length === 0 ? <li className="text-muted-foreground">No open paper positions checked yet.</li> : null}
            </ul>
          </div>
          <div>
            <div className="font-medium">
              Chain scan · {chain?.tickers?.length ?? 0} tickers · {chain?.scans ?? 0} scans {chain?.note ? `(${chain.note})` : ""}
            </div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {hits.slice(0, 25).map((h) => (
                <li key={h.key}>
                  {fmtT(h.at)} {h.contract} +{h.deltaAsk} ask ({Math.round(h.askShareOfDelta * 100)}%) @ {h.midAtHit}
                  {h.maxGainPct != null ? ` → max ${signed(h.maxGainPct)}` : ""}
                </li>
              ))}
              {hits.length === 0 ? <li>No building hits yet.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
