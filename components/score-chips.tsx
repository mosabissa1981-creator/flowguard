import { cn } from "@/lib/utils";
import type { ScoreChip } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ScoreChips({
  chips,
  limit,
  compact = false,
}: {
  chips: ScoreChip[];
  limit?: number;
  compact?: boolean;
}) {
  const shown = typeof limit === "number" ? chips.slice(0, limit) : chips;
  const hidden = typeof limit === "number" ? chips.length - shown.length : 0;

  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((chip) => (
        <Tooltip key={chip.id}>
          <TooltipTrigger
            className={cn(
              "inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium tracking-wide",
              compact ? "text-[10px]" : "text-[11px]",
              chip.kind === "boost"
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/25 bg-rose-500/10 text-rose-300",
            )}
          >
            {chip.label}
            <span className="ml-1 font-mono text-[10px] opacity-70">
              {chip.delta > 0 ? `+${chip.delta}` : chip.delta}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-xs leading-relaxed">
            {chip.detail}
          </TooltipContent>
        </Tooltip>
      ))}
      {hidden > 0 ? (
        <span className="px-1 font-mono text-[10px] text-muted-foreground">+{hidden}</span>
      ) : null}
    </div>
  );
}
