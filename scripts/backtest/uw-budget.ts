/**
 * Budgeted Unusual Whales client for the box-side history jobs.
 * Every request reads `x-uw-daily-req-count` (the token's count for the UW day, which resets 8 pm ET and
 * includes the live site) and refuses to call once it reaches UW_STOP_AT (default 35,000), keeping ~2,500 for the live site under the 37,500 ceiling; ≥ 1,500
 * in reserve for the live site under the 39,000/day hard ceiling (never exceeded even if
 * UW_STOP_AT is set higher).
 */
export class BudgetStop extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BudgetStop";
  }
}

const BASE = "https://api.unusualwhales.com";
const HARD_CAP = 39_000;
export const STOP_AT = Math.min(Number(process.env.UW_STOP_AT || 35_000), HARD_CAP - 1_500);
const RUN_MAX = Number(process.env.UW_RUN_MAX || 1e9);

/** UW_SEED_COUNT: start from the site count (tokenCount at /api/uw-usage) when UW omits the daily header. */
export const budget = { tokenCountToday: Number(process.env.UW_SEED_COUNT) || 0, runCalls: 0, errors: 0, stopped: "" as string };

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export function rawFetch(input: RequestInfo | URL, init?: RequestInit) {
  return realFetch(input, init);
}

function key(): string {
  const k = process.env.UNUSUAL_WHALES_API_KEY?.trim();
  if (!k) throw new Error("UNUSUAL_WHALES_API_KEY not set");
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** UW_OFFLINE=1: cache-only run, never calls UW (e.g. before the 8 pm ET reset once the day's budget is spent). */
const OFFLINE = process.env.UW_OFFLINE === "1";
export function canSpend(n = 1): boolean {
  if (OFFLINE) {
    budget.stopped ||= "UW_OFFLINE=1 (cache-only run)";
    return false;
  }
  return !budget.stopped && budget.tokenCountToday + n < STOP_AT && budget.runCalls + n <= RUN_MAX;
}

/** GET a UW path (with query) → parsed JSON. Throws BudgetStop when the cap is reached. */
export async function uwJson<T = unknown>(pathAndQuery: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (!canSpend()) {
      budget.stopped ||= `UW budget stop at token count ${budget.tokenCountToday} (cap ${STOP_AT}) / run calls ${budget.runCalls}`;
      throw new BudgetStop(budget.stopped);
    }
    budget.runCalls += 1;
    let res: Response;
    try {
      res = await realFetch(`${BASE}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${key()}`, "UW-CLIENT-API-ID": "100001", Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      budget.errors += 1;
      if (attempt >= 3) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const c = Number(res.headers.get("x-uw-daily-req-count"));
    // UW stopped sending the daily-count header (Oct 7 2026): count locally so the stop still works.
    if (Number.isFinite(c) && c > 0) budget.tokenCountToday = c;
    else budget.tokenCountToday += 1;
    if (res.ok) return (await res.json()) as T;
    const body = (await res.text()).slice(0, 300);
    budget.errors += 1;
    if (res.status === 429 && /daily/i.test(body)) {
      budget.stopped = "UW daily request limit hit";
      throw new BudgetStop(budget.stopped);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    throw new Error(`UW ${res.status} ${pathAndQuery.split("?")[0]}: ${body.replace(/Bearer\s+\S+/g, "Bearer ***")}`);
  }
}
