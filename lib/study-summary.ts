import summary from "@/study/study-summary.json";
import type { StudySummaryBrief } from "@/lib/types";

type FullSummary = StudySummaryBrief & {
  generatedAt: string;
  days: number;
  definition: string;
  recentDecided: Array<{
    day: string;
    contract: string;
    ticker: string;
    type: string;
    dte: number | null;
    score: number | null;
    lane: string | null;
    bucket: string;
    outcome: string;
    pct: number | null;
    tags: string[];
  }>;
};

/**
 * Compact study-book outcomes (built by scripts/build-study-summary.mjs from the desk books).
 * Regenerate + commit to refresh; the AI prompt and /api/study-summary read this.
 */
export function loadStudySummary(limit = 20): FullSummary {
  const full = summary as unknown as FullSummary;
  return { ...full, recentDecided: full.recentDecided.slice(-limit) };
}

export function studyBrief(): StudySummaryBrief {
  const s = loadStudySummary(0);
  return {
    since: s.since,
    through: s.through,
    totals: s.totals,
    buckets: s.buckets,
    correlatedLossClusters: s.correlatedLossClusters,
    lessons: s.lessons,
  };
}
