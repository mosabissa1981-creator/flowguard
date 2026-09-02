import { cn } from "@/lib/utils";
import type { HoldWindow } from "@/lib/types";

export function HoldWindowCopy({
  hold,
  compact = false,
  className,
}: {
  hold: HoldWindow;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(compact ? "space-y-0" : "space-y-0.5", className)}>
      <p className={cn(compact ? "text-[11px] leading-snug" : "text-sm leading-snug")}>{hold.line}</p>
      <p
        className={cn(
          "text-muted-foreground",
          compact ? "text-[10px] leading-snug" : "text-xs leading-snug",
        )}
      >
        {hold.exit}
      </p>
    </div>
  );
}
