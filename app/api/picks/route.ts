import { loadDailyPicks } from "@/lib/picks";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadDailyPicks();
  return Response.json(payload, {
    headers: { "Cache-Control": "s-maxage=45, stale-while-revalidate=30" },
  });
}
