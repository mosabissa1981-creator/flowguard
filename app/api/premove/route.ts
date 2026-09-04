import { loadPremoveShortlist } from "@/lib/premove";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadPremoveShortlist();
  return Response.json(payload, {
    headers: { "Cache-Control": "s-maxage=45, stale-while-revalidate=30" },
  });
}
