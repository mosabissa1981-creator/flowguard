import { loadPuts } from "@/lib/puts";

export const dynamic = "force-dynamic";

/** Puts lane (TEST mode). Cached 10 min in memory + 5 min at the edge; zero extra flow calls. */
export async function GET() {
  try {
    return Response.json(await loadPuts(), { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json(
      { mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed", picks: [] },
      { status: 500 },
    );
  }
}
