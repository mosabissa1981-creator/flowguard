import { NextRequest } from "next/server";

import { isPriceWatch } from "@/lib/price-watches";
import {
  loadStoredWatches,
  removeStoredWatch,
  saveStoredWatches,
  upsertStoredWatch,
} from "@/lib/watch-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const watches = await loadStoredWatches();
  return Response.json({
    watches,
    persisted: true,
    note:
      process.env.VERCEL === "1"
        ? "Vercel disk is ephemeral. Prefer POST /api/watches/check with the browser watch list."
        : "File store at data/watches.json for local monitor jobs.",
  });
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
    const saved = await saveStoredWatches(watches);
    return Response.json({ watches, persisted: saved.persisted });
  }

  if (!isPriceWatch(body.watch)) {
    return Response.json({ error: "Invalid options watch." }, { status: 400 });
  }

  const watches = await upsertStoredWatch(body.watch);
  return Response.json({ watches, persisted: true });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return Response.json({ error: "Pass ?id=." }, { status: 400 });
  }
  const watches = await removeStoredWatch(id);
  return Response.json({ watches });
}
