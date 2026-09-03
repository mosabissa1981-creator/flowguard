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
import type { OptionType, PriceWatch } from "@/lib/types";

type ContractSeed = {
  ticker: string;
  option_chain: string;
  strike: string;
  expiry: string;
  type: OptionType;
  price: string;
};

export function PickWatchControls({
  seed,
  watches,
  onSave,
}: {
  seed: ContractSeed;
  watches: PriceWatch[];
  onSave: (watch: PriceWatch) => void;
}) {
  const [expand, setExpand] = useState<"adverse" | "entry" | null>(null);
  const [justBought, setJustBought] = useState(false);
  const [justEntry, setJustEntry] = useState(false);
  const suggested = toNumber(seed.price);
  const hasAdverse = watches.some((watch) => watch.id === watchId("adverse", seed.option_chain));
  const hasEntry = watches.some((watch) => watch.id === watchId("entry_approach", seed.option_chain));

  if (!seed.option_chain) return null;

  function oneTapBought() {
    if (!suggested || suggested <= 0) {
      setExpand("adverse");
      return;
    }
    onSave(
      makeAdverseWatch({
        ticker: seed.ticker,
        option_chain: seed.option_chain,
        strike: seed.strike,
        expiry: seed.expiry,
        type: seed.type,
        entryPremium: suggested,
        lastFlowPrint: suggested,
      }),
    );
    setJustBought(true);
    setTimeout(() => setJustBought(false), 2000);
  }

  function oneTapEntry() {
    if (!suggested || suggested <= 0) {
      setExpand("entry");
      return;
    }
    onSave(
      makeEntryWatch({
        ticker: seed.ticker,
        option_chain: seed.option_chain,
        strike: seed.strike,
        expiry: seed.expiry,
        type: seed.type,
        targetPremium: suggested,
        lastFlowPrint: suggested,
      }),
    );
    setJustEntry(true);
    setTimeout(() => setJustEntry(false), 2000);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={hasAdverse || justBought ? "secondary" : "outline"}
          onClick={oneTapBought}
          disabled={justBought}
        >
          <Check className="size-3.5" />
          {justBought ? "Armed ✓" : hasAdverse ? "Bought ✓" : "Bought"}
        </Button>
        <Button
          size="sm"
          variant={hasEntry || justEntry ? "secondary" : "outline"}
          onClick={oneTapEntry}
          disabled={justEntry}
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
                lastFlowPrint: suggested || entry,
              }),
            );
            setExpand(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Adjust entry premium and stop. Default adverse threshold is 15%.
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
                lastFlowPrint: suggested || target,
              }),
            );
            setExpand(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Adjust target entry premium. Default approach band is 5%.
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
