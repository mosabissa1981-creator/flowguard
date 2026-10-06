import { NextRequest } from "next/server";

import { resolveArmingPremium } from "@/lib/arming";
import { parseOcc } from "@/lib/paper-core";
import { parsePremiumInput } from "@/lib/price-watches";

export const dynamic = "force-dynamic";

const USAGE =
  "Use /api/quote?ticker=NFLX&option_chain=NFLX261023C00070000&alertPrice=1.83 (alertPrice optional). " +
  "symbol=<OCC> is also accepted and the ticker is read from it.";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // `symbol=` / `occ=` aliases: older study routines passed the OCC symbol only.
  const occ = (params.get("option_chain") ?? params.get("symbol") ?? params.get("occ") ?? "").trim().toUpperCase();
  const parsed = occ ? parseOcc(occ) : null;
  const ticker = (params.get("ticker")?.trim().toUpperCase() || parsed?.ticker || "").trim();
  const optionChain = occ;
  const alertPrice = parsePremiumInput(params.get("alertPrice") ?? params.get("alert_price"));
  if (optionChain && !parsed && !params.get("ticker")) {
    return Response.json(
      { error: `"${optionChain}" is not an OCC option symbol like NFLX261023C00070000. ${USAGE}`, usage: USAGE },
      { status: 400 },
    );
  }
  if (!ticker || !optionChain) {
    const got = [...params.keys()].join(", ") || "none";
    return Response.json(
      {
        error: `Missing ${!optionChain ? "option_chain (OCC symbol)" : "ticker"}. Got params: ${got}. ${USAGE}`,
        usage: USAGE,
      },
      { status: 400 },
    );
  }
  if (!parsed) {
    return Response.json(
      { error: `option_chain "${optionChain}" is not an OCC symbol like NFLX261023C00070000. ${USAGE}`, usage: USAGE },
      { status: 400 },
    );
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
