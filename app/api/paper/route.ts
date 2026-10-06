import { NextRequest, after } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { loadPaperSnapshot, loadPaperView, logExternalPaperTrade, paperTick, paperTickQuietly, type ExternalTradeInput } from "@/lib/paper";
import { tradingDateET } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel cron (Bearer CRON_SECRET when set) or the admin key may force a tick. */
function forceOk(request: NextRequest): boolean {
  const key = request.nextUrl.searchParams.get("key") ?? request.headers.get("x-admin-key");
  if (adminOk(key)) return true;
  const secret = process.env.CRON_SECRET?.trim();
  const auth = request.headers.get("authorization") ?? "";
  if (secret) return auth === `Bearer ${secret}`;
  return /vercel-cron/i.test(request.headers.get("user-agent") ?? "");
}

/**
 * PAPER / TEST MODE account (fake money; never touches live picks or places orders).
 * GET                → live view (balance, P&L, open, last 10 closed) and a throttled tick after the response.
 * GET ?day=YYYY-MM-DD → stored daily snapshot (study routine saves it as study/paper-YYYY-MM-DD.json).
 * GET ?tick=1        → cron/admin: run a forced tick now (exits + time stops, even after the close).
 * POST (admin key)   → log an external test-lane trade, e.g. { book: "earnings-calendar", legs: [...], exitBy }.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  try {
    const day = p.get("day");
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day !== tradingDateET()) {
      const snap = await loadPaperSnapshot(day);
      if (!snap) return Response.json({ mode: "paper-test", error: `No paper snapshot for ${day}.` }, { status: 404 });
      return Response.json(snap, { headers: { "Cache-Control": "s-maxage=300" } });
    }
    if (p.get("tick") === "1" && forceOk(request)) {
      const tick = await paperTick({ force: true });
      return Response.json({ tick, ...(await loadPaperView()) }, { headers: { "Cache-Control": "no-store" } });
    }
    after(() => paperTickQuietly());
    return Response.json(await loadPaperView(), { headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=30" } });
  } catch (error) {
    return Response.json({ mode: "paper-test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") ?? request.headers.get("x-admin-key");
  if (!adminOk(key)) return Response.json({ error: "Admin key required." }, { status: 401 });
  let body: ExternalTradeInput;
  try {
    body = (await request.json()) as ExternalTradeInput;
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const out = await logExternalPaperTrade(body);
  return Response.json(out, { status: out.ok ? 200 : 422 });
}
