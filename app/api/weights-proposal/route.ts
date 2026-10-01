import proposal from "@/study/weight-proposal.json";

export const dynamic = "force-static";

/** Latest weekly scoring-weight PROPOSAL (scripts/propose-weights.mjs). Never applied automatically. */
export async function GET() {
  return Response.json(proposal, { headers: { "Cache-Control": "s-maxage=3600" } });
}
