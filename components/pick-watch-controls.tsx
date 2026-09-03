"use client";

import { useState } from "react";

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
  const [form, setForm] = useState<"adverse" | "entry" | null>(null);
  const suggested = toNumber(seed.price);
  const hasAdverse = watches.some((watch) => watch.id === watchId("adverse", seed.option_chain));
  const hasEntry = watches.some((watch) => watch.id === watchId("entry_approach", seed.option_chain));

  if (!seed.option_chain) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={hasAdverse || form === "adverse" ? "secondary" : "outline"}
          onClick={() => setForm((value) => (value === "adverse" ? null : "adverse"))}
        >
          {hasAdverse ? "Edit track" : "Track entry"}
        </Button>
        <Button
          size="sm"
          variant={hasEntry || form === "entry" ? "secondary" : "outline"}
          onClick={() => setForm((value) => (value === "entry" ? null : "entry"))}
        >
          {hasEntry ? "Edit entry watch" : "Watch for entry"}
        </Button>
      </div>

      {form === "adverse" ? (
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
            setForm(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            You bought this option. Alert if live premium moves against you. Options only — never
            auto-trades.
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
            <input
              name="adversePct"
              type="text"
              inputMode="decimal"
              defaultValue="15"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <label className="block text-xs">
            Optional stop premium
            <input
              name="stop"
              type="text"
              inputMode="decimal"
              placeholder="Leave blank to use % only"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Save position watch
          </button>
        </form>
      ) : null}

      {form === "entry" ? (
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
            setForm(null);
          }}
        >
          <p className="text-xs text-muted-foreground">
            Not in yet. Alert when live premium is within the band of this target. Default target is
            the last print.
          </p>
          <label className="block text-xs">
            Target entry premium
            <input
              name="target"
              type="text"
              inputMode="decimal"
              defaultValue={suggested ? String(suggested) : ""}
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <label className="block text-xs">
            Approach % (default 5)
            <input
              name="approachPct"
              type="text"
              inputMode="decimal"
              defaultValue="5"
              className="mt-1 h-11 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-base"
            />
          </label>
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Save entry watch
          </button>
        </form>
      ) : null}
    </div>
  );
}
