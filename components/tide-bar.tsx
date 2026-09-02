import { cn } from "@/lib/utils";
import { formatPremium } from "@/lib/format";
import type { TideSnapshot } from "@/lib/types";

export function TideBar({
  tide,
  label = "Market tide",
}: {
  tide: TideSnapshot | null;
  label?: string;
}) {
  if (!tide) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="uppercase tracking-[0.16em]">{label}</span>
        <span>unavailable</span>
      </div>
    );
  }

  const total = Math.abs(tide.netCallPremium) + Math.abs(tide.netPutPremium) || 1;
  const callPct = (Math.abs(tide.netCallPremium) / total) * 100;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="hidden shrink-0 flex-col sm:flex">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "font-mono text-xs font-semibold uppercase",
            tide.bias === "bullish" && "text-emerald-300",
            tide.bias === "bearish" && "text-rose-300",
            tide.bias === "neutral" && "text-zinc-300",
          )}
        >
          {tide.bias}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="bg-emerald-400" style={{ width: `${callPct}%` }} />
          <div className="bg-rose-400" style={{ width: `${100 - callPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span className="text-emerald-300/90">C {formatPremium(tide.netCallPremium)}</span>
          <span className="text-rose-300/90">P {formatPremium(tide.netPutPremium)}</span>
        </div>
      </div>
    </div>
  );
}
