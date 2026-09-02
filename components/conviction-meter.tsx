import { cn } from "@/lib/utils";

export function convictionTone(score: number): "high" | "mid" | "low" {
  if (score >= 75) return "high";
  if (score >= 55) return "mid";
  return "low";
}

export function ConvictionMeter({
  score,
  size = "md",
}: {
  score: number;
  size?: "sm" | "md";
}) {
  const tone = convictionTone(score);
  return (
    <div className={cn("flex items-center gap-2", size === "sm" ? "min-w-16" : "min-w-24")}>
      <div
        className={cn(
          "relative overflow-hidden rounded-full bg-muted",
          size === "sm" ? "h-1.5 w-12" : "h-2 w-16",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            tone === "high" && "bg-emerald-400",
            tone === "mid" && "bg-amber-400",
            tone === "low" && "bg-rose-400/80",
          )}
          style={{ width: `${score}%` }}
        />
      </div>
      <span
        className={cn(
          "font-mono tabular-nums font-semibold tracking-tight",
          size === "sm" ? "text-xs" : "text-sm",
          tone === "high" && "text-emerald-300",
          tone === "mid" && "text-amber-300",
          tone === "low" && "text-rose-300",
        )}
      >
        {score}
      </span>
    </div>
  );
}
