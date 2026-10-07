import "server-only";

import { kvSetNx } from "@/lib/kv";
import { loadChainScan } from "@/lib/shadow/chain-scan";
import { loadFadeWatch } from "@/lib/shadow/fade-watch";
import { loadFollowThrough } from "@/lib/shadow/follow-through";
import { etClock } from "@/lib/shadow/budget";
import { flushUwUsage } from "@/lib/uw-usage";

/** One shared tick for the intraday shadow jobs; at most once per ~170 s across all instances. */
export async function runShadowTick(now = new Date()) {
  const c = etClock(now);
  if (!c.weekday || c.minutes < 9 * 60 + 30 || c.minutes >= 16 * 60 + 5) return { ran: false, why: "outside market hours" };
  const got = await kvSetNx("flowguard/shadow/tick-lock", now.toISOString(), 170);
  if (!got) return { ran: false, why: "throttled (≤ 1 tick / 170 s)" };
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const v = (await fn()) as { note?: string | null; uwCalls?: number };
      out[name] = { ok: true, note: v?.note ?? null, uwCallsToday: v?.uwCalls ?? null };
    } catch (e) {
      out[name] = { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "failed" };
    }
  };
  await step("fadeWatch", () => loadFadeWatch({ now, refresh: true }));
  await step("followThrough", () => loadFollowThrough({ now }));
  await step("chainScan", () => loadChainScan({ now, refresh: true }));
  await flushUwUsage().catch(() => undefined);
  return { ran: true, at: now.toISOString(), jobs: out };
}
