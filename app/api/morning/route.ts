import { loadMorningShortlist } from "@/lib/morning";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadMorningShortlist();
  return Response.json(payload, {
    headers: { "Cache-Control": "s-maxage=120, stale-while-revalidate=60" },
  });
}
