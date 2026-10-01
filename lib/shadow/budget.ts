import "server-only";

import { dailyBudgetUsd } from "@/lib/shadow/llm";
import { loadDoc } from "@/lib/shadow/store";
import type { BriefDoc, ReleaseReadDoc, ShadowDay } from "@/lib/shadow/types";

/** Sum of today's shadow LLM spend across the candidate run, the brief and release reads. */
export async function daySpendUsd(day: string): Promise<number> {
  const [shadow, brief, reads] = await Promise.all([
    loadDoc<ShadowDay>("day", day),
    loadDoc<BriefDoc>("brief", day),
    loadDoc<ReleaseReadDoc>("release", day),
  ]);
  let total = shadow?.llm.spendUsd ?? 0;
  total += brief?.usage?.costUsd ?? 0;
  for (const r of reads?.reads ?? []) total += r.usage?.costUsd ?? 0;
  return Math.round(total * 10000) / 10000;
}

export async function budgetLeft(day: string): Promise<number> {
  return dailyBudgetUsd() - (await daySpendUsd(day));
}

/** ET wall-clock minutes since midnight and weekday. */
export function etClock(now: Date): { minutes: number; weekday: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24;
  const m = Number(get("minute"));
  const wd = get("weekday");
  return { minutes: h * 60 + m, weekday: wd !== "Sat" && wd !== "Sun" };
}
