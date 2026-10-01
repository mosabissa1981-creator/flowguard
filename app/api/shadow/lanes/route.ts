import { NextRequest } from "next/server";

import { tradingDateET } from "@/lib/session";
import { adminOk } from "@/lib/shadow/admin";
import { type LanePick, loadLaneDebate, refreshLaneDebate, sampleLaneDebate } from "@/lib/shadow/lane-debate";
import { storeHealth } from "@/lib/shadow/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Shadow debate verdicts (TAKE/SKIP) on TEST-lane picks (Puts + setup lanes). Never changes lane picks.
 *  - GET /api/shadow/lanes               → today; lazily judges newly logged picks (one batched call, ≥30 min apart, budgeted).
 *  - GET /api/shadow/lanes?day=YYYY-MM-DD → stored day (read-only). Study routine saves it as study/lane-debate-<day>.json.
 *  - ?refresh=1&key=<AI_PICKS_ADMIN_SECRET> → bypass throttle / hours (budget still applies).
 *  - ?diag=1&key=<admin> → Blob write/read round-trip check.
 *  - POST ?key=<admin> {picks:[...]} → sample debate on hand-supplied picks (stored under `samples`, not scored).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const today = tradingDateET();
  const day = params.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  if (params.get("diag") === "1") {
    if (!adminOk(params.get("key"))) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(await storeHealth(), { headers: { "Cache-Control": "no-store" } });
  }
  try {
    if (day && day !== today) {
      const doc = await loadLaneDebate(day);
      if (!doc) return Response.json({ error: `no lane debate stored for ${day}` }, { status: 404 });
      return Response.json(doc, { headers: { "Cache-Control": "s-maxage=600" } });
    }
    const force = params.get("refresh") === "1" && adminOk(params.get("key"));
    return Response.json(await refreshLaneDebate({ force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!adminOk(request.nextUrl.searchParams.get("key"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { picks?: Array<Partial<LanePick>> };
    const picks: LanePick[] = (body.picks ?? []).slice(0, 12).map((p) => ({
      lane: String(p.lane ?? "sample"),
      side: p.side === "call" ? "call" : "put",
      contract: String(p.contract ?? ""),
      ticker: String(p.ticker ?? ""),
      strike: Number(p.strike) || 0,
      expiry: String(p.expiry ?? ""),
      dte: Number(p.dte) || 0,
      entry: Number(p.entry) || 0,
      underlying: Number(p.underlying) || 0,
      otmPct: Number(p.otmPct) || 0,
      askSharePct: Number(p.askSharePct) || 0,
      volOi: Number(p.volOi) || 0,
      premiumUsd: Number(p.premiumUsd) || 0,
      reasons: Array.isArray(p.reasons) ? p.reasons.map(String).slice(0, 8) : [],
      timeStopSessions: Number(p.timeStopSessions) || 3,
    }));
    if (!picks.length || picks.some((p) => !p.contract || !p.ticker)) return Response.json({ error: "picks[] with contract + ticker required" }, { status: 400 });
    return Response.json(await sampleLaneDebate(picks), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
