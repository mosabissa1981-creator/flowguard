import { loadPutsBook, summarizePuts } from "@/lib/puts";
import { retiredBody } from "@/lib/retired-lanes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Puts lane tracking — RETIRED 10/18/2026 (lib/retired-lanes.ts). Returns the stored book read-only (no UW calls,
 * no re-tracking) so older study/puts-YYYY-MM-DD.json history stays consistent.
 */
export async function GET() {
  try {
    const book = await loadPutsBook(true);
    return Response.json(
      retiredBody("puts", { generatedAt: new Date().toISOString(), summary: summarizePuts(book.entries), entries: book.entries, uwCalls: 0 }),
      { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=60" } },
    );
  } catch (error) {
    return Response.json(retiredBody("puts", { error: error instanceof Error ? error.message.slice(0, 200) : "failed", entries: [] }), { status: 500 });
  }
}
