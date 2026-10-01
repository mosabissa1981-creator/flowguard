import { NextRequest } from "next/server";

import { tradingDateET } from "@/lib/session";
import { adminOk } from "@/lib/shadow/admin";
import { blankDay, loadShadowDay, publicView, refreshShadow } from "@/lib/shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Shadow-mode module verdicts per candidate (they never change the live lists).
 *  - GET /api/shadow                → today's verdicts; lazily refreshes (LLM parts throttled: ≥30 min, budgeted).
 *  - GET /api/shadow?day=2026-10-01 → stored day (read-only) — the study routine saves this as study/shadow-<day>.json.
 *  - &full=1                        → include raw module caches (news, debate, UW vol/earnings/historic).
 *  - ?refresh=1&key=<AI_PICKS_ADMIN_SECRET> → bypass the throttle (budget still applies).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const full = params.get("full") === "1";
  const today = tradingDateET();
  const day = params.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  if (day && day !== today) {
    const doc = await loadShadowDay(day);
    if (!doc) return Response.json({ error: `no shadow output stored for ${day}` }, { status: 404 });
    return Response.json(publicView(doc, full), { headers: { "Cache-Control": "s-maxage=600" } });
  }
  const readOnly = params.get("readonly") === "1";
  const force = params.get("refresh") === "1" && adminOk(params.get("key"));
  let doc;
  try {
    doc = readOnly ? ((await loadShadowDay(today)) ?? blankDay(today)) : await refreshShadow({ force });
  } catch (e) {
    const stored = await loadShadowDay(today);
    doc = stored ?? { ...blankDay(today), llm: { ...blankDay(today).llm, status: "error" as const, lastError: e instanceof Error ? e.message.slice(0, 200) : "error" } };
  }
  return Response.json(publicView(doc, full), { headers: { "Cache-Control": "no-store" } });
}
