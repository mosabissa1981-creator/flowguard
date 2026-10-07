import "server-only";

import { kvSetNx } from "@/lib/kv";
import { paperTick } from "@/lib/paper";
import { tradingDateET } from "@/lib/session";
import { loadChainScan } from "@/lib/shadow/chain-scan";
import { loadFadeWatch } from "@/lib/shadow/fade-watch";
import { loadFollowThrough } from "@/lib/shadow/follow-through";
import { etClock } from "@/lib/shadow/budget";
import { flushUwUsage, runAsUwJob } from "@/lib/uw-usage";

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
  // Paper account (TEST): before this, paper ticks only ran in after() hooks of page routes, so with nobody on
  // the site entries, stops/targets and the 15:30 ET time stops stalled (Oct 7: last tick 1:19 PM CT).
  // Normal tick = entries + exits (exits ≤ every 15 min, own 120 s throttle). Once a day after 15:30 ET a forced
  // tick re-checks every position so time stops close before the bell.
  await step("paper", async () => {
    const minutes = c.minutes;
    let force = false;
    if (minutes >= 15 * 60 + 31 && minutes < 16 * 60) {
      force = await kvSetNx(`flowguard/paper/timestop-${tradingDateET(now)}`, now.toISOString(), 36 * 3600);
    }
    const r = await runAsUwJob("paper", () => paperTick({ force, now }));
    return { note: `${r.ran ? (force ? "forced time-stop check" : "tick") : r.reason}; opened ${r.opened}, closed ${r.closed}, exitCheck ${r.exitCheck}` };
  });
  await step("fadeWatch", () => loadFadeWatch({ now, refresh: true }));
  await step("followThrough", () => loadFollowThrough({ now }));
  await step("chainScan", () => loadChainScan({ now, refresh: true }));
  await flushUwUsage().catch(() => undefined);
  return { ran: true, at: now.toISOString(), jobs: out };
}
