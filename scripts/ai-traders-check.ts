/** Sanity checks for the AI trader league core (pure logic). Run: npm run ai-traders-check */
import assert from "node:assert/strict";

import {
  AI_TRADER_BOOK,
  AI_TRADER_MAX_PICKS,
  AI_TRADER_SPREAD_MAX_PCT,
  capTakes,
  inWeek,
  qualityGate,
  scoreAiTraderWeek,
  weekEndFriday,
  weekStartMonday,
} from "../lib/ai-traders-core";

assert.equal(AI_TRADER_SPREAD_MAX_PCT, 0.04);
assert.equal(AI_TRADER_MAX_PICKS, 3);
assert.equal(AI_TRADER_BOOK.grok, "ai-grok");
assert.equal(AI_TRADER_BOOK.claude, "ai-claude");
assert.equal(AI_TRADER_BOOK.gpt, "ai-gpt");

assert.equal(qualityGate({ ask: 2, premiumUsd: 100_000, score: 90, spreadPct: 0.04 }).ok, true);
assert.equal(qualityGate({ ask: 1.99, premiumUsd: 100_000, score: 90, spreadPct: 0.04 }).ok, false);
assert.equal(qualityGate({ ask: 2, premiumUsd: 99_999, score: 90, spreadPct: 0.04 }).ok, false);
assert.equal(qualityGate({ ask: 2, premiumUsd: 100_000, score: 89, spreadPct: 0.04 }).ok, false);
assert.equal(qualityGate({ ask: 2, premiumUsd: 100_000, score: 90, spreadPct: 0.041 }).ok, false);
assert.equal(qualityGate({ ask: 2, premiumUsd: 100_000, score: 90, spreadPct: null }).ok, true);

assert.deepEqual(capTakes([1, 2, 3, 4]), [1, 2, 3]);
assert.deepEqual(capTakes([1, 2], 3), [1, 2]);

assert.equal(weekStartMonday("2026-11-13"), "2026-11-09"); // Fri → Mon
assert.equal(weekStartMonday("2026-11-09"), "2026-11-09");
assert.equal(weekEndFriday("2026-11-09"), "2026-11-13");
assert.equal(inWeek("2026-11-12", "2026-11-09", "2026-11-13"), true);
assert.equal(inWeek("2026-11-14", "2026-11-09", "2026-11-13"), false);

const scored = scoreAiTraderWeek([
  { trader: "grok", closed: [{ pnlUsd: -50, pnlPct: -20 }, { pnlUsd: -30, pnlPct: -15 }] },
  { trader: "claude", closed: [{ pnlUsd: 40, pnlPct: 20 }, { pnlUsd: 10, pnlPct: 5 }] },
  { trader: "gpt", closed: [] },
]);
assert.equal(scored.winner, "claude");
assert.equal(scored.standings[0].trader, "claude");
assert.equal(scored.standings[0].pnlUsd, 50);
assert.equal(scoreAiTraderWeek([{ trader: "grok", closed: [] }, { trader: "claude", closed: [] }, { trader: "gpt", closed: [] }]).winner, null);

console.log("ai-traders-check: all assertions passed");
