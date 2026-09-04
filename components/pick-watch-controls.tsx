"use client";

import { useState } from "react";
import { Check, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toNumber } from "@/lib/numbers";
import {
  DEFAULT_ADVERSE_PCT,
  DEFAULT_APPROACH_PCT,
  makeAdverseWatch,
  makeEntryWatch,
  parsePctInput,
  parsePremiumInput,
  watchId,
} from "@/lib/price-watches";
import type { ArmingPremium, OptionType, PriceWatch } from "@/lib/types";
import { formatPrice } from "@/lib/format";

type ContractSeed = {
  ticker: string;
  option_chain: string;
  strike: string;
  expiry: string;
  type: OptionType;
  price: string;
};

async function fetchArming(seed: ContractSeed): Promise<ArmingPremium> {
  const alertPrice = toNumber(seed.price);
  const params = new URLSearchParams({
    ticker: seed.ticker,
    option_chain: seed.option_chain,
  });
  if (alertPrice > 0) params.set("alertPrice", String(alertPrice));
  try {
    const response = await fetch(`/api/quote?${params}`, { cache: "no-store" });
    if (response.ok) return (await response.json()) as ArmingPremium;
  } catch {
    // Fall through to the alert print.
  }
  const premium = alertPrice;
  return {
    premium,
    source: "alert",
    label: premium > 0 ? `${formatPrice(premium)} (alert print)` : "no premium",
    asOf: null,
  };
}

export function PickWatchControls({
  seed,
  watches,
  onSave,
}: {
  seed: ContractSeed;
  watches: PriceWatch[];
  onSave: (watch: PriceWatch, resolvePremium?: boolean) => void;
}) {
  const [expand, setExpand] = useState<"adverse" | "entry" | null>(null);
  const [justBought, setJustBought] = useState(false);
  const [justEntry, setJustEntry] = useState(false);
  const [arming, setArming] = useState<ArmingPremium | null>(null);
  const [busy, setBusy] = useState(false);

  const alertPx = toNumber(seed.price);
  const suggested = arming && arming.premium > 0 ? arming.premium : alertPx;
  const hasAdverse = watches.some((watch) => watch.id === watchId("adverse", seed.option_chain));
  const hasEntry = watches.some((watch) => watch.id === watchId("entry_approach", seed.option_chain));

  if (!seed.option_chain) return null;

  async function oneTapBought() {
    setBusy(true);
    const resolved = arming ?? (await fetchArming(seed));
    setArming(resolved);
    if (!resolved.premium || resolved.premium <= 0) {
      setExpand("adverse");
      setBusy(false);
      return;
    }
    onSave(
      makeAdverseWatch({
        ticker: seed.ticker,
        option_chain: seed.option_chain,
        strike: seed.strike,
        expiry: seed.expiry,
        type: seed.type,
        entryPremium: resolved.premium,
        lastFlowPrint: alertPx || resolved.premium,
        referenceSource: resolved.source,
      }),
      true,
    );
    setJustBought(true);
    setBusy(false);
    setTimeout(() => setJustBought(false), 2000);
  }

  async function oneTapEntry() {
    setBusy(true);
    const resolved = arming ?? (await fetchArming(seed));
    setArming(resolved);
    if (!resolved.premium || resolved.premium <= 0) {
      setExpand("entry");
      setBusy(false);
      return;
    }
    onSave(
      makeEntryWatch({
        ticker: seed.ticker,
        option_chain: seed.option_chain,
        strike: seed.strike,
        expiry: seed.expiry,
        type: seed.type,
        targetPremium: resolved.premium,
        lastFlowPrint: alertPx || resolved.premium,
        referenceSource: resolved.source,
      }),
      true,
    );
    setJustEntry(true);
    setBusy(false);
    setTimeout(() => setJustEntry(false), 2000);
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Arm at {arming?.label ?? (alertPx > 0 ? `${formatPrice(alertPx)} (alert print)` : "alert print")}
        {arming && arming.source !== "alert" && alertPx > 0 && Math.abs(arming.premium - alertPx) / alertPx >= 0.02
          ? ` · alert was ${formatPrice(alertPx)}`
          : ""}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={hasAdverse || justBought ? "secondary" : "outline"}
          onClick={() => void oneTapBought()}
          disabled={justBought || busy}
        >
          <Check className="size-3.5" />
          {justBought ? "Armed ✓" : hasAdverse ? "Bought ✓" : "Bought"}
        </Button>
        <Button
          size="sm"
          variant={hasEntry || justEntry ? "secondary" : "outline"}
          onClick={() => void oneTapEntry()}
          disabled={justEntry || busy}
        >
          <Eye className="size-3.5" />
          {justEntry ? "Watching ✓" : hasEntry ? "Watching ✓" : "Watch entry"}
        </Button>
        {(hasAdverse || hasEntry) && !expand ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpand(hasAdverse ? "adverse" : "entry")}
          >
            Adjust
          </Button>
        ) : null}
      </div>

      {expand === "adverse" ? (
        <form
          className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const entry = parsePremiumInput(data.get("entry")) ?? suggested;
            const stop = parsePremiumInput(data.get("stop"));
            if (!entry) return;
            onSave(
              makeAdverseWatch({
                ticker: seed.ticker,
                option_chain: seed.option_chain,
                strike: seed.strike,
                expiry: seed.expiry,
                type: seed.type,
                entryPremium: entry,
                adversePct: parsePctInput(data.get("adversePct"), DEFAULT_ADVERSE_PCT),
                stopPremium: stop ?? undefined,
                lastFlowPrint: alertPx || entry,
                referenceSource: arming?.source,
              }),
              false,
            );
            setExpand(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Default is the live quote when UW has one — not the stale alert print. Adverse 15%.
          </p>
          <label className="block text-xs">
            Entry premium
            <input
              name="entry"
              type="text"
              inputMode="decimal"
              defaultValue={suggested ? String(suggested) : ""}
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <label className="block text-xs">
            Adverse % (default 15)
            <input name="adversePct" type="text" inputMode="decimal" defaultValue="15"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <label className="block text-xs">
            Optional stop premium
            <input name="stop" type="text" inputMode="decimal" placeholder="Blank = % only"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            >Save</button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpand(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {expand === "entry" ? (
        <form
          className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const target = parsePremiumInput(data.get("target")) ?? suggested;
            if (!target) return;
            onSave(
              makeEntryWatch({
                ticker: seed.ticker,
                option_chain: seed.option_chain,
                strike: seed.strike,
                expiry: seed.expiry,
                type: seed.type,
                targetPremium: target,
                approachPct: parsePctInput(data.get("approachPct"), DEFAULT_APPROACH_PCT),
                lastFlowPrint: alertPx || target,
                referenceSource: arming?.source,
              }),
              false,
            );
            setExpand(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Default is the live quote when UW has one. Approach band 5%.
          </p>
          <label className="block text-xs">
            Target entry premium
            <input name="target" type="text" inputMode="decimal"
              defaultValue={suggested ? String(suggested) : ""}
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <label className="block text-xs">
            Approach % (default 5)
            <input name="approachPct" type="text" inputMode="decimal" defaultValue="5"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            >Save</button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpand(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
