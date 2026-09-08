import { NextRequest } from "next/server";

import {
  buildCheckResponse,
  evaluateWatch,
  isPriceWatch,
  shouldDropArmedWatch,
} from "@/lib/price-watches";
import { fetchWatchSnapshots, hasUnusualWhalesKey, quoteFromFlowPrint } from "@/lib/uw";
import {
  archiveExpiredWatches,
  loadStoredWatches,
  removeStoredWatches,
} from "@/lib/watch-store";
import { fireWebhook } from "@/lib/watch-webhook";
import { isUwBlocked } from "@/lib/uw-quota";
import type { PriceWatch } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return check(await loadStoredWatches(), true);
}

export async function POST(request: NextRequest) {
  let body: { watches?: unknown };
  try {
    body = (await request.json()) as { watches?: unknown };
  } catch {
    return Response.json({ error: "Send JSON { watches } or use GET to check server watches." }, { status: 400 });
  }

  const incoming = Array.isArray(body.watches) ? body.watches.filter(isPriceWatch) : [];
  const watches: PriceWatch[] = incoming.length > 0 ? incoming : await loadStoredWatches();
  return check(watches, true);
}

async function check(watches: PriceWatch[], persistExpire: boolean) {
  const blocked = await isUwBlocked();
  const snapshots =
    !blocked && (await hasUnusualWhalesKey())
      ? await fetchWatchSnapshots(
          watches.map((watch) => ({
            ticker: watch.ticker,
            option_chain: watch.option_chain,
            lastFlowPrint: watch.lastFlowPrint,
          })),
        )
      : Object.fromEntries(
          watches.map((watch) => [
            watch.option_chain,
            { quote: quoteFromFlowPrint(watch.lastFlowPrint), historic: [] },
          ]),
        );

  const evaluations = watches.map((watch) => {
    const snap = snapshots[watch.option_chain];
    const quote = snap?.quote ?? quoteFromFlowPrint(watch.lastFlowPrint);
    return evaluateWatch(watch, quote, { historic: snap?.historic ?? [] });
  });

  const dropping = evaluations.filter((row) => shouldDropArmedWatch(row));
  const removedIds = dropping.map((row) => row.watch.id);
  if (persistExpire && removedIds.length > 0) {
    await archiveExpiredWatches(
      dropping.map((row) => ({
        watch: row.watch,
        reason: row.hint ?? row.status,
        pctMove: row.pctMove,
      })),
    );
    await removeStoredWatches(removedIds);
    await Promise.all(dropping.map((row) => fireWebhook(row.watch, "expired").catch(() => {})));
  }

  const remaining = evaluations.filter((row) => !removedIds.includes(row.watch.id));
  const payload = buildCheckResponse(evaluations);
  return Response.json({
    ...payload,
    evaluations: remaining,
    removedIds,
  });
}
