"use client";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FlowFilters } from "@/lib/types";

const PREMIUM_OPTIONS = [
  { value: "0", label: "Any premium" },
  { value: "10000", label: "≥ $10k" },
  { value: "25000", label: "≥ $25k" },
  { value: "50000", label: "≥ $50k" },
  { value: "100000", label: "≥ $100k" },
  { value: "250000", label: "≥ $250k" },
  { value: "500000", label: "≥ $500k" },
];

export function FilterBar({
  filters,
  onChange,
}: {
  filters: FlowFilters;
  onChange: (next: FlowFilters) => void;
}) {
  return (
    <section className="grid gap-3 rounded-xl border border-border/80 bg-card/80 p-3 md:grid-cols-12 md:items-end">
      <label className="flex flex-col gap-1.5 md:col-span-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Ticker
        </span>
        <Input
          value={filters.ticker}
          placeholder="All names"
          className="font-mono uppercase"
          onChange={(event) =>
            onChange({ ...filters, ticker: event.target.value.toUpperCase() })
          }
        />
      </label>

      <label className="flex flex-col gap-1.5 md:col-span-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Min premium
        </span>
        <Select
          value={String(filters.minPremium)}
          onValueChange={(value) =>
            onChange({ ...filters, minPremium: Number(value ?? "0") })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PREMIUM_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1.5 md:col-span-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Side
        </span>
        <Select
          value={filters.side}
          onValueChange={(value) =>
            onChange({
              ...filters,
              side: value === "call" || value === "put" ? value : "all",
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Calls + puts</SelectItem>
            <SelectItem value="call">Calls only</SelectItem>
            <SelectItem value="put">Puts only</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <div className="flex flex-col gap-2 md:col-span-3">
        <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <span>DTE</span>
          <span className="font-mono text-foreground">
            {filters.minDte}–{filters.maxDte}
          </span>
        </div>
        <Slider
          min={0}
          max={120}
          value={[filters.minDte, filters.maxDte]}
          onValueChange={(value) => {
            const range = Array.isArray(value) ? value : [filters.minDte, filters.maxDte];
            const minDte = Math.min(range[0] ?? 0, range[1] ?? 0);
            const maxDte = Math.max(range[0] ?? 0, range[1] ?? 120);
            onChange({ ...filters, minDte, maxDte });
          }}
        />
      </div>

      <div className="flex flex-col gap-2 md:col-span-3">
        <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <span>Min conviction</span>
          <span className="font-mono text-foreground">{filters.minConviction}</span>
        </div>
        <Slider
          min={0}
          max={90}
          step={5}
          value={[filters.minConviction]}
          onValueChange={(value) =>
            onChange({
              ...filters,
              minConviction: Array.isArray(value) ? (value[0] ?? 0) : value,
            })
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-border/70 pt-3 md:col-span-12 md:border-0 md:pt-0">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={filters.unusual}
            onCheckedChange={(checked) => onChange({ ...filters, unusual: checked })}
          />
            <span>
            Unusual preset
            <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">
              this session: opening / vol&gt;OI / sweep / floor / named rule
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={filters.strictAntiFade}
            onCheckedChange={(checked) =>
              onChange({ ...filters, strictAntiFade: checked })
            }
          />
          <span>
            Strict anti-fade
            <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">
              hide lotteries, bid-side, fighting tide, one-and-done, aged/stale
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}
