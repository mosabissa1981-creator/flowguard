/** Shared types for the replay output (no side effects; safe to import from nightly.ts). */
export type ReplayEntry = {
  lane: string; // lane id | puts | lottery | picks | premove | cand:<lane>
  kind: "logged" | "candidate";
  contract: string;
  ticker: string;
  side: "call" | "put";
  expiry: string;
  day: string;
  entry: number;
  printTimeUtc: string | null;
  underlying?: number | null;
  timeStopSessions: number;
  features: Record<string, number | string | boolean | null>;
};

export type ReplayDay = { v: 1; day: string; prints: number; entries: ReplayEntry[]; unhandled: Record<string, number>; ms: number };

