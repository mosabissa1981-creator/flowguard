import { NextRequest } from "next/server";

import { resolveArmingPremium } from "@/lib/arming";
import { isPriceWatch } from "@/lib/price-watches";
import {
  loadStoredWatches,
  removeStoredWatch,
  saveStoredWatches,
  upsertStoredWatch,
} from "@/lib/watch-store";
import { fireWebhook } from "@/lib/watch-webhook";
import { isUwBlocked } from "@/lib/uw-quota";
import type { PriceWatch } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  let watches: Awaited<ReturnType<typeof loadStoredWatches>> = [];
  try {
    watches = await loadStoredWatches();
  } catch {
    watches = [];
  }
  return Response.json({ watches, count: watches.length });
}

export async function POST(request: NextRequest) {
  let body: { watch?: unknown; watches?: unknown; resolvePremium?: boolean };
  try {
    body = (await request.json()) as { watch?: unknown; watches?: unknown; resolvePremium?: boolean };
  } catch {
    return Response.json({ error: "Send JSON { watch } or { watches }." }, { status: 400 });
  }

  if (Array.isArray(body.watches)) {
    const watches = body.watches.filter(isPriceWatch);
    const persisted = await saveStoredWatches(watches);
    return Response.json({ watches, persisted });
  }

  if (!isPriceWatch(body.watch)) {
    return Response.json({ error: "Invalid options watch." }, { status: 400 });
  }

  let watch: PriceWatch = body.watch;
  if (body.resolvePremium !== false && !(await isUwBlocked())) {
    try {
      const arming = await resolveArmingPremium({
        ticker: watch.ticker,
        option_chain: watch.option_chain,
        alertPrice: watch.lastFlowPrint ?? watch.referencePremium,
      });
      if (arming.premium > 0) {
        watch = {
          ...watch,
          referencePremium: arming.premium,
          referenceSource: arming.source,
          lastFlowPrint: watch.lastFlowPrint ?? watch.referencePremium,
        };
      }
    } catch {
      // Keep the client-supplied premium.
    }
  }

  const watches = await upsertStoredWatch(watch);
  const webhook = await fireWebhook(watch, "armed");
  return Response.json({ watch, watches, persisted: true, webhook });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return Response.json({ error: "Pass ?id=." }, { status: 400 });
  }
  const before = await loadStoredWatches();
  const removed = before.find((w) => w.id === id);
  const watches = await removeStoredWatch(id);
  if (removed) await fireWebhook(removed, "removed").catch(() => {});
  return Response.json({ watches });
}
