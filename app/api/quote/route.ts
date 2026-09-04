import { NextRequest } from "next/server";

import { resolveArmingPremium } from "@/lib/arming";
import { parsePremiumInput } from "@/lib/price-watches";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker")?.trim() ?? "";
  const optionChain = request.nextUrl.searchParams.get("option_chain")?.trim() ?? "";
  const alertPrice = parsePremiumInput(request.nextUrl.searchParams.get("alertPrice"));
  if (!ticker || !optionChain) {
    return Response.json({ error: "Pass ticker and option_chain." }, { status: 400 });
  }
  try {
    const arming = await resolveArmingPremium({
      ticker,
      option_chain: optionChain,
      alertPrice: alertPrice ?? undefined,
    });
    return Response.json(arming);
  } catch {
    const premium = alertPrice ?? 0;
    return Response.json({
      premium,
      source: "alert",
      label: premium > 0 ? `$${premium.toFixed(2)} (alert print)` : "no premium",
      asOf: null,
    });
  }
}
