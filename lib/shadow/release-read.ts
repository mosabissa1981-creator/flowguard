import "server-only";

import { loadRegimeSafe } from "@/lib/regime";
import { tradingDateET } from "@/lib/session";
import { budgetLeft } from "@/lib/shadow/budget";
import { callShadowLlm, parseJsonObject, shadowLlmConfig } from "@/lib/shadow/llm";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { ReleaseRead, ReleaseReadDoc } from "@/lib/shadow/types";
import type { EconEvent, RegimeSnapshot } from "@/lib/types";

/**
 * post_release_read — after NFP / CPI / PPI / PCE / ISM / FOMC statement / FOMC minutes (regime calendar),
 * one search call per release group: actual vs forecast, hot/cool read, market reaction, implications.
 * Lazily generated on request ≥ release + 3 min; at most one generation per request. Never sends messages.
 */

export const RELEASE_READ_EVENTS =
  /Non-?Farm|Employment Report|Unemployment Rate|Average Hourly|\bCPI\b|Consumer Price|\bPPI\b|Producer Price|ISM (Manufacturing|Services)|ISM .*PMI|FOMC Statement|Federal Funds|Rate Decision|FOMC (Meeting )?Minutes|Core PCE|PCE Price/i;
const DELAY_MS = 3 * 60_000;
const RETRY_MS = 10 * 60_000;
let inflight: Promise<ReleaseReadDoc> | null = null;

type Group = { key: string; releaseAt: string; events: EconEvent[] };

export function releaseGroups(events: EconEvent[], day: string): Group[] {
  const map = new Map<string, Group>();
  for (const e of events) {
    if (!RELEASE_READ_EVENTS.test(e.title) || /speaks|speech|ADP/i.test(e.title)) continue;
    const t = new Date(e.date);
    if (!Number.isFinite(t.getTime()) || tradingDateET(t) !== day) continue;
    const iso = t.toISOString();
    const g = map.get(iso) ?? { key: "", releaseAt: iso, events: [] };
    g.events.push(e);
    map.set(iso, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, key: g.events.map((e) => e.title).join(" + ") }))
    .sort((a, b) => a.releaseAt.localeCompare(b.releaseAt));
}

export async function loadReleaseReads(opts: { generate?: boolean; now?: Date; regime?: RegimeSnapshot | null } = {}): Promise<ReleaseReadDoc> {
  const now = opts.now ?? new Date();
  const day = tradingDateET(now);
  const stored = (await loadDoc<ReleaseReadDoc & { attempts?: Record<string, number> }>("release", day)) ?? {
    day,
    updatedAt: now.toISOString(),
    reads: [],
    pending: [],
  };
  const regime = opts.regime === undefined ? await loadRegimeSafe() : opts.regime;
  const groups = releaseGroups(regime?.events.today ?? [], day);
  const done = new Set(stored.reads.filter((r) => r.status === "ok").map((r) => r.event));
  const due = groups.filter((g) => !done.has(g.key) && Date.parse(g.releaseAt) + DELAY_MS <= now.getTime());
  const view: ReleaseReadDoc = { ...stored, pending: groups.filter((g) => !done.has(g.key)).map((g) => `${g.key} @ ${g.releaseAt}`) };
  if (!opts.generate || !due.length) return view;
  if (!shadowLlmConfig()?.searchEnabled) return { ...view, pending: view.pending.map((p) => `${p} (no xAI key)`) };
  const attempts = stored.attempts ?? {};
  const next = due.find((g) => !attempts[g.key] || Date.now() - attempts[g.key] > RETRY_MS);
  if (!next) return view;
  if ((await budgetLeft(day)) <= 0) return view;
  if (inflight) return inflight;
  inflight = generate(day, next, { ...stored, attempts }, now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function generate(day: string, g: Group, stored: ReleaseReadDoc & { attempts: Record<string, number> }, now: Date): Promise<ReleaseReadDoc> {
  stored.attempts[g.key] = Date.now();
  await saveDoc("release", day, stored);
  const system = [
    "You are a macro desk analyst. Use web and X search to find the just-released US data below.",
    "Report actual vs consensus vs prior, call it hot / cool / inline / mixed (hot = hawkish/inflationary/strong),",
    "describe the first market reaction (2Y/10Y yields, dollar, index futures) and the implications for the session",
    "(rate-sensitive sectors, long-duration tech, small caps, Fed odds). Terse, factual; if the data is not out yet say so in headline.",
    'Return JSON only: {"actual":"","forecast":"","previous":"","temperature":"hot|cool|inline|mixed","headline":"<=140 chars",',
    '"marketReaction":"<=200 chars","implications":["<=120 chars", ...max 4],"deskNote":"<=160 chars"}',
  ].join(" ");
  const user = JSON.stringify({
    release: g.key,
    releasedAtEt: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(g.releaseAt)),
    calendar: g.events.map((e) => ({ title: e.title, forecast: e.forecast, previous: e.previous })),
    asOf: now.toISOString(),
  });
  let read: ReleaseRead;
  try {
    const res = await callShadowLlm({ module: "post_release_read", system, user, search: { web: true, x: true, fromDate: day, maxTurns: 2 } });
    const r = parseJsonObject<NonNullable<ReleaseRead["read"]>>(res.text);
    read = {
      event: g.key,
      releaseAt: g.releaseAt,
      generatedAt: new Date().toISOString(),
      status: r ? "ok" : "error",
      model: res.usage.model,
      usage: res.usage,
      error: r ? undefined : "invalid-output",
      read: r
        ? {
            actual: String(r.actual ?? ""),
            forecast: String(r.forecast ?? ""),
            previous: String(r.previous ?? ""),
            temperature: ["hot", "cool", "inline", "mixed"].includes(r.temperature) ? r.temperature : "mixed",
            headline: String(r.headline ?? "").slice(0, 200),
            marketReaction: String(r.marketReaction ?? "").slice(0, 300),
            implications: (r.implications ?? []).slice(0, 4).map(String),
            deskNote: String(r.deskNote ?? "").slice(0, 200),
          }
        : null,
    };
  } catch (error) {
    read = { event: g.key, releaseAt: g.releaseAt, generatedAt: new Date().toISOString(), status: "error", error: (error instanceof Error ? error.message : String(error)).slice(0, 200), read: null };
  }
  const reads = [...stored.reads.filter((r) => r.event !== g.key), read];
  const doc = { ...stored, updatedAt: new Date().toISOString(), reads };
  await saveDoc("release", day, doc);
  return { day, updatedAt: doc.updatedAt, reads, pending: stored.pending.filter((p) => !p.startsWith(g.key)) };
}
