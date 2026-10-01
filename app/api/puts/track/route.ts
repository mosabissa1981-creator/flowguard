import { trackPuts } from "@/lib/puts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Multi-day (T+1..T+5) tracking of logged test-mode puts. Study routine saves it daily as study/puts-YYYY-MM-DD.json. */
export async function GET() {
  try {
    return Response.json(await trackPuts(), { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
