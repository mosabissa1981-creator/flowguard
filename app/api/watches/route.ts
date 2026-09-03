import { NextRequest } from "next/server";

import { isPriceWatch } from "@/lib/price-watches";
import {
  loadStoredWatches,
  removeStoredWatch,
  saveStoredWatches,
  upsertStoredWatch,
} from "@/lib/watch-store";
import { fireWebhook } from "@/lib/watch-webhook";

export const dynamic = "force-dynamic";

export async function GET() {
  const hasToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
  let debug: string | null = null;
  let watches: Awaited<ReturnType<typeof loadStoredWatches>> = [];
  try {
    watches = await loadStoredWatches();
  } catch (error) {
    debug = error instanceof Error ? error.message : String(error);
  }
  return Response.json({ watches, count: watches.length, blobConfigured: hasToken, debug });
}

export async function POST(request: NextRequest) {
  let body: { watch?: unknown; watches?: unknown };
  try {
    body = (await request.json()) as { watch?: unknown; watches?: unknown };
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

  const watches = await upsertStoredWatch(body.watch);
  const webhook = await fireWebhook(body.watch, "armed");
  return Response.json({ watches, persisted: true, webhook });
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
