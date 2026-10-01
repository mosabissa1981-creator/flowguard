import "server-only";

import { loadRegimeSafe } from "@/lib/regime";
import { tradingDateET } from "@/lib/session";
import { budgetLeft, etClock } from "@/lib/shadow/budget";
import { callShadowLlm, parseJsonObject, shadowLlmConfig } from "@/lib/shadow/llm";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { BriefDoc } from "@/lib/shadow/types";
import type { RegimeSnapshot } from "@/lib/types";

/**
 * premarket_brief — once per trading day from ~8:25 CT (9:25 ET): overnight news, yields drivers,
 * today's reports + expectations. One search call (~$0.05–0.15), cached for the day in Blob.
 */

const BRIEF_FROM_ET_MIN = 9 * 60 + 25;
const RETRY_MS = 10 * 60_000;
let inflight: Promise<BriefDoc> | null = null;

const fmtEt = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export async function loadBrief(opts: { generate?: boolean; now?: Date; regime?: RegimeSnapshot | null; force?: boolean } = {}): Promise<BriefDoc> {
  const now = opts.now ?? new Date();
  const day = tradingDateET(now);
  const stored = await loadDoc<BriefDoc & { attemptAt?: number }>("brief", day);
  if (stored?.status === "ok" && !opts.force) return stored;
  const pending = (status: BriefDoc["status"], error?: string): BriefDoc => ({ day, generatedAt: now.toISOString(), status, brief: null, error });
  if (!opts.generate) return stored ?? pending("pending", "Brief is generated on the first request after 8:25 CT on trading days.");
  if (!shadowLlmConfig()?.searchEnabled) return stored ?? pending("no-key", "LLM_API_KEY (xAI) not set — brief unavailable.");
  const clock = etClock(now);
  if (!opts.force && (!clock.weekday || clock.minutes < BRIEF_FROM_ET_MIN)) {
    return stored ?? pending("pending", "Brief is generated on the first request after 8:25 CT on trading days.");
  }
  if (!opts.force && stored?.attemptAt && Date.now() - stored.attemptAt < RETRY_MS) return stored;
  if ((await budgetLeft(day)) <= 0) return stored ?? pending("budget", "Daily shadow LLM budget reached.");
  if (inflight) return inflight;
  inflight = generate(day, now, opts.regime).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function generate(day: string, now: Date, regimeIn?: RegimeSnapshot | null): Promise<BriefDoc> {
  const attemptAt = Date.now();
  await saveDoc("brief", day, { day, generatedAt: now.toISOString(), status: "pending", brief: null, attemptAt });
  const regime = regimeIn === undefined ? await loadRegimeSafe() : regimeIn;
  const calendar = (regime?.events.today ?? []).map((e) => `${fmtEt(e.date)} ET ${e.title} (fcst ${e.forecast || "?"}, prev ${e.previous || "?"})`);
  const system = [
    "You write the pre-market brief for a US options-flow desk. Use web and X search for news since yesterday's close.",
    "Cover: overnight/pre-market news that moves US equities, what is driving Treasury yields (2Y/10Y/30Y) and why,",
    "today's scheduled US reports with consensus expectations and what a hot/cool print would mean, and notable pre-market earnings.",
    "Be factual and terse; cite nothing inline. Ignore anything after the as-of time.",
    'Return JSON only: {"summary":"<=300 chars","riskTone":"risk-on|risk-off|mixed","overnight":["<=120 chars",...max 5],',
    '"yields":"<=200 chars","reports":[{"timeEt":"HH:MM","title":"","expectation":"<=120 chars"}],"drivers":["<=100 chars",...max 4],"watch":["<=100 chars",...max 4]}',
  ].join(" ");
  const user = JSON.stringify({
    asOf: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(now) + " ET",
    deskCalendarToday: calendar,
    deskRegime: regime ? { label: regime.label, reasons: regime.reasons, us10yChangeBp: regime.yields.us10y.changeBp, us30yChangeBp: regime.yields.us30y.changeBp } : null,
  });
  try {
    const res = await callShadowLlm({ module: "premarket_brief", system, user, search: { web: true, x: true, fromDate: new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10), maxTurns: 2 } });
    const b = parseJsonObject<NonNullable<BriefDoc["brief"]>>(res.text);
    const doc: BriefDoc & { attemptAt: number } = {
      day,
      generatedAt: new Date().toISOString(),
      status: b ? "ok" : "error",
      model: res.usage.model,
      usage: res.usage,
      error: b ? undefined : "invalid-output",
      brief: b
        ? {
            summary: String(b.summary ?? "").slice(0, 400),
            riskTone: ["risk-on", "risk-off", "mixed"].includes(b.riskTone) ? b.riskTone : "mixed",
            overnight: (b.overnight ?? []).slice(0, 5).map(String),
            yields: String(b.yields ?? "").slice(0, 300),
            reports: (b.reports ?? []).slice(0, 8).map((r) => ({ timeEt: String(r.timeEt ?? ""), title: String(r.title ?? ""), expectation: String(r.expectation ?? "") })),
            drivers: (b.drivers ?? []).slice(0, 4).map(String),
            watch: (b.watch ?? []).slice(0, 4).map(String),
          }
        : null,
      attemptAt,
    };
    await saveDoc("brief", day, doc);
    return doc;
  } catch (error) {
    const doc = { day, generatedAt: new Date().toISOString(), status: "error" as const, brief: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 200), attemptAt };
    await saveDoc("brief", day, doc);
    return doc;
  }
}

/** Compact one-liner for other prompts (debate / optional ai-picks context). */
export function briefLine(doc: BriefDoc | null): string | null {
  if (!doc?.brief) return null;
  return `${doc.brief.riskTone}: ${doc.brief.summary} Yields: ${doc.brief.yields}`.slice(0, 700);
}
