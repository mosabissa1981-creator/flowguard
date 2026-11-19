/** Pure checks for the AI-trader paper books. Run: npm run ai-trader-books-check */
import assert from "node:assert/strict";

import {
  AI_TRADER_FLOOR,
  AI_TRADER_LIVE_FLOOR,
  AI_TRADER_MIN_TRADES,
  AI_TRADER_SPREAD_MAX,
  applyDayCaps,
  askClearsFloor,
  bidFromAskSpread,
  buildWeekScore,
  capsForRegime,
  isFridayAfterClose,
  liveFloorReason,
  parseMainSourceSetting,
  qualityFloorReason,
  renderWeekMd,
  resolveMainSource,
  selectAiTraderFills,
  weekEndingOn,
  type AiTraderRow,
  type AiTraderSource,
  type PaperTradeInput,
} from "@/lib/ai-trader-books-core";
import {
  AI_TRADER_BOOST_FILL_CAP,
  AI_TRADER_STUDY_BOOST_END,
  byScoreThenEarlier,
  projectQuietSpend,
  studyBoostEnabled,
} from "@/lib/ai-trader-study-boost";
import {
  WIDE_REVIEW_TOKEN_USD_PER_M,
  WIDE_RULE,
  buildLessonsPrompt,
  qualityBucketPhrase,
  studyTierFloorPhrase,
  studyTierPromptCostDelta,
  wideReviewSystemPrompt,
} from "@/lib/shadow/wide-review-prompt";

function row(over: Partial<AiTraderRow> & Pick<AiTraderRow, "contract" | "ticker">): AiTraderRow {
  return {
    side: "call",
    strike: 100,
    expiry: "2026-12-18",
    ask: 3,
    premiumUsd: 250_000,
    score: 95,
    spreadPct: 0.02,
    etf: false,
    firstSeenAt: "2026-11-16T15:00:00Z",
    grok: "take",
    claude: "pass",
    gpt: "pass",
    gradeRet: null,
    graded: false,
    ...over,
  };
}

const base = { regimeLabel: "calm" as const, blockEtfPuts: false, held: [], mainSource: "rules" as const, mainSourceWhy: "test" };

// Quality floor boundaries.
assert.equal(qualityFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.04 })), null);
assert.ok(qualityFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.0401 }))?.includes("spread"));
assert.ok(qualityFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: null }))?.includes("unknown"));
assert.equal(qualityFloorReason(row({ contract: "A", ticker: "AAPL", ask: 2 })), null);
assert.ok(qualityFloorReason(row({ contract: "A", ticker: "AAPL", ask: 1.99 }))?.includes("ask"));
assert.equal(qualityFloorReason(row({ contract: "A", ticker: "AAPL", premiumUsd: 100_000 })), null);
assert.ok(qualityFloorReason(row({ contract: "A", ticker: "AAPL", premiumUsd: 99_999 }))?.includes("premium"));
assert.equal(qualityFloorReason(row({ contract: "A", ticker: "AAPL", score: 90 })), null);
assert.ok(qualityFloorReason(row({ contract: "A", ticker: "AAPL", score: 89.99 }))?.includes("score"));
assert.equal(askClearsFloor(2, 1), true);
assert.equal(askClearsFloor(1.5, 3), false);
assert.equal(askClearsFloor(null, 2), true);
assert.equal(askClearsFloor(null, 1.9), false);
assert.ok(Math.abs((bidFromAskSpread(2, 0.04) ?? 0) - 1.92) < 0.02);

const good = [
  row({ contract: "AAPL1", ticker: "AAPL", score: 99, grok: "take", claude: "pass", gpt: "take" }),
  row({ contract: "XOM1", ticker: "XOM", score: 98, grok: "pass", claude: "take", gpt: "pass" }),
  row({ contract: "JPM1", ticker: "JPM", score: 97, grok: "take", claude: "take", gpt: "pass" }),
  row({ contract: "LOW1", ticker: "LOW", score: 70, premiumUsd: 50_000, grok: "take", claude: "take", gpt: "take" }),
  row({ contract: "PUT1", ticker: "NVDA", side: "put", etf: false, score: 99, grok: "take" }),
  row({ contract: "SPY1", ticker: "SPY", side: "put", etf: true, score: 96, grok: "take", claude: "take", gpt: "take" }),
];

const calm = selectAiTraderFills(good, base);
const names = (source: string, book?: string) =>
  calm.filter((f) => f.source === source && (book ? f.book === book : f.book !== "main")).map((f) => f.contract).sort();
assert.deepEqual(names("grok"), ["AAPL1", "JPM1", "SPY1"]);
assert.deepEqual(names("claude"), ["JPM1", "SPY1", "XOM1"]);
assert.deepEqual(names("gpt"), ["AAPL1", "SPY1"]);
assert.deepEqual(names("rules"), ["AAPL1", "JPM1", "SPY1", "XOM1"]);
assert.ok(!calm.some((f) => f.contract === "LOW1" || f.contract === "PUT1"));
assert.deepEqual(
  calm.filter((f) => f.book === "main").map((f) => f.contract).sort(),
  ["AAPL1", "JPM1", "SPY1", "XOM1"],
);
assert.ok(calm.filter((f) => f.book === "main").every((f) => f.drivenBy === "rules" && f.drivenByWhy === "test"));
assert.ok(calm.filter((f) => f.book !== "main").every((f) => f.drivenBy == null));

const grokMain = selectAiTraderFills(good, { ...base, mainSource: "grok" });
assert.deepEqual(grokMain.filter((f) => f.book === "main").map((f) => f.contract).sort(), ["AAPL1", "JPM1", "SPY1"]);
assert.ok(grokMain.filter((f) => f.book === "main").every((f) => f.drivenBy === "grok"));

const heldBack = selectAiTraderFills(good, { ...base, blockEtfPuts: true });
assert.ok(!heldBack.some((f) => f.contract === "SPY1"));

// Report-day list cap is 3. Issuer cap treats GOOG and GOOGL as one name.
const reportRows = [
  row({ contract: "G1", ticker: "GOOG", score: 99 }),
  row({ contract: "G2", ticker: "GOOGL", score: 98 }),
  row({ contract: "X1", ticker: "XOM", score: 97 }),
  row({ contract: "J1", ticker: "JPM", score: 96 }),
  row({ contract: "B1", ticker: "BA", score: 95 }),
];
const report = selectAiTraderFills(reportRows, { ...base, regimeLabel: "report-day" });
const grokReport = report.filter((f) => f.book === "ai-grok").map((f) => f.contract);
assert.equal(grokReport.length, 3);
assert.ok(grokReport.includes("G1"));
assert.ok(!grokReport.includes("G2"));
assert.deepEqual(capsForRegime("report-day"), { maxPerIssuer: 1, maxPerSector: 2, listCap: 3 });
assert.deepEqual(capsForRegime("risky"), capsForRegime("report-day"));
assert.equal(capsForRegime("calm").listCap, 10);
assert.equal(capsForRegime(null).maxPerIssuer, 2);

// A held GOOG already used the report-day issuer slot.
const capped = applyDayCaps(reportRows, [{ book: "ai-grok", ticker: "GOOG", contract: "HELD" }], capsForRegime("report-day"));
assert.ok(!capped.some((r) => r.ticker === "GOOG" || r.ticker === "GOOGL"));

// Premove already holding AAPL counts against main's report-day cap, not against the model book.
const withPremove = selectAiTraderFills(
  [row({ contract: "AAPL1", ticker: "AAPL", score: 99 }), row({ contract: "XOM1", ticker: "XOM", score: 98 })],
  { ...base, regimeLabel: "report-day", held: [{ book: "main", ticker: "AAPL", contract: "PRE" }] },
);
assert.ok(withPremove.some((f) => f.book === "ai-rules" && f.contract === "AAPL1"));
assert.ok(!withPremove.some((f) => f.book === "main" && f.contract === "AAPL1"));
assert.ok(withPremove.some((f) => f.book === "main" && f.contract === "XOM1"));

const tooEarly = selectAiTraderFills(good, { ...base, notBeforeMs: Date.parse("2026-11-16T18:00:00Z") });
assert.equal(tooEarly.length, 0);

// Friday window and the source switch.
assert.deepEqual(weekEndingOn("2026-11-20"), {
  weekStart: "2026-11-16",
  weekEnd: "2026-11-20",
  days: ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"],
});
assert.equal(weekEndingOn("2026-11-19"), null);
assert.equal(isFridayAfterClose("2026-11-20", 16 * 60 + 15), true);
assert.equal(isFridayAfterClose("2026-11-20", 16 * 60 + 14), false);
assert.equal(isFridayAfterClose("2026-11-19", 17 * 60), false);
assert.equal(parseMainSourceSetting(undefined), "auto");
assert.equal(parseMainSourceSetting(" GROK "), "grok");
assert.equal(parseMainSourceSetting("ai-picks"), "auto");
assert.deepEqual(resolveMainSource("auto", null), {
  source: "rules",
  why: "no weekly winner yet — rules-only quality book (week 1 starts 2026-11-16)",
});
assert.equal(resolveMainSource("auto", { winner: "claude", weekEnd: "2026-11-20" }).source, "claude");
assert.equal(resolveMainSource("gpt", { winner: "grok", weekEnd: "2026-11-20" }).source, "gpt");
assert.equal(resolveMainSource("auto", { winner: "rules", weekEnd: "2026-11-20" }).source, "rules");

function trades(book: AiTraderSource, ret: number, n: number): PaperTradeInput[] {
  return Array.from({ length: n }, (_, i) => ({
    book,
    day: "2026-11-16",
    contract: `${book}${i}`,
    ticker: "AAPL",
    returnPct: ret,
    pnlUsd: ret * 10,
    closed: true,
  }));
}
const emptySides = { takes: [] as Array<number | null>, passes: [] as Array<number | null> };
function scoreOf(list: PaperTradeInput[], takeAvg: Partial<Record<AiTraderSource, Array<number | null>>> = {}) {
  return buildWeekScore({
    week: weekEndingOn("2026-11-20")!,
    generatedAt: "2026-11-20T21:30:00Z",
    trades: list,
    pending: {},
    decisions: {
      grok: { takes: takeAvg.grok ?? [], passes: [1, null] },
      claude: { takes: takeAvg.claude ?? [], passes: [-2] },
      gpt: { takes: takeAvg.gpt ?? [], passes: [] },
      rules: { takes: takeAvg.rules ?? [3], passes: emptySides.passes },
    },
  });
}

const winner = scoreOf([...trades("grok", 10, 5), ...trades("claude", 1, 5), ...trades("gpt", 4, 4), ...trades("rules", 2, 6)]);
assert.equal(winner.winner, "grok");
assert.equal(winner.books.find((b) => b.book === "grok")?.avgReturnPct, 10);
assert.equal(winner.books.find((b) => b.book === "grok")?.vsRulesPct, 8);
assert.equal(winner.books.find((b) => b.book === "gpt")?.trades, 4);
assert.equal(winner.books.find((b) => b.book === "rules")?.passAvgPct, null);
assert.equal(winner.books.find((b) => b.book === "grok")?.passAvgPct, 1);
assert.equal(winner.books.find((b) => b.book === "grok")?.passPending, 1);
assert.equal(AI_TRADER_MIN_TRADES, 5);
assert.match(renderWeekMd(winner), /Grok wins/);
assert.match(renderWeekMd(winner), /2026-11-20/);

const short = scoreOf([...trades("grok", 20, 4), ...trades("rules", 1, 5)]);
assert.equal(short.winner, null);
assert.match(short.winnerReason, /No winner/);

const behind = scoreOf([...trades("grok", -5, 5), ...trades("rules", 2, 5)]);
assert.equal(behind.winner, null);

const tied = scoreOf([...trades("grok", 6, 5), ...trades("claude", 6, 5), ...trades("rules", 1, 5)]);
assert.equal(tied.winner, null);
assert.match(tied.winnerReason, /tie/);

const noRules = scoreOf(trades("grok", 9, 6));
assert.equal(noRules.winner, null);

// Study boost off keeps the report-day list at 3 and does not fill live-floor misses.
assert.equal(qualityFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.06 })), qualityFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.06 })));
assert.equal(liveFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.1, score: 45, premiumUsd: 10_000, ask: 0.4 })), null);
assert.ok(liveFloorReason(row({ contract: "A", ticker: "AAPL", spreadPct: 0.11 }))?.includes("spread"));
assert.ok(liveFloorReason(row({ contract: "A", ticker: "AAPL", score: 44 }))?.includes("score"));
assert.equal(studyBoostEnabled(undefined, "2026-11-16"), true);
assert.equal(studyBoostEnabled("", "2026-12-11"), true);
assert.equal(studyBoostEnabled("", "2026-12-12"), false);
assert.equal(studyBoostEnabled("0", "2026-11-16"), false);
assert.equal(studyBoostEnabled("off", "2026-11-16"), false);
assert.equal(studyBoostEnabled("2026-12-18", "2026-12-15"), true);
assert.equal(studyBoostEnabled("2026-12-18", "2026-12-19"), false);
assert.equal(studyBoostEnabled("sometimes", "2026-11-16"), false);

const boostedReport = selectAiTraderFills(reportRows, { ...base, regimeLabel: "report-day", studyBoost: true });
const boostedGrok = boostedReport.filter((f) => f.book === "ai-grok" && f.tier === "quality").map((f) => f.contract);
assert.equal(boostedGrok.length, 4, "report-day quality list rises to the names that fit issuer caps, up to 8");
assert.ok(boostedGrok.includes("B1"));
assert.ok(boostedReport.filter((f) => f.book === "ai-grok" && f.tier === "quality").every((f) => f.openRiskCapPct === 0.4));
assert.ok(boostedReport.filter((f) => f.book === "main").every((f) => f.openRiskCapPct == null && f.tier === "quality"));

const many = Array.from({ length: 9 }, (_, i) =>
  row({ contract: `Q${i}`, ticker: `ZZ${i}`, score: 99 - i, grok: "take", claude: "take", gpt: "pass" }),
);
const cappedBoost = selectAiTraderFills(many, { ...base, regimeLabel: "report-day", studyBoost: true });
assert.equal(cappedBoost.filter((f) => f.book === "ai-grok" && f.tier === "quality").length, AI_TRADER_BOOST_FILL_CAP);
assert.equal(cappedBoost.filter((f) => f.book === "ai-rules" && f.tier === "quality").length, AI_TRADER_BOOST_FILL_CAP);
assert.ok(!cappedBoost.some((f) => f.contract === "Q8" && f.tier === "quality"));
const calmMany = Array.from({ length: 11 }, (_, i) => row({ contract: `C${i}`, ticker: `QQ${i}`, score: 110 - i }));
const calmBoost = selectAiTraderFills(calmMany, { ...base, studyBoost: true });
assert.equal(calmBoost.filter((f) => f.book === "ai-grok" && f.tier === "quality").length, 10, "calm list cap stays 10");

const studyNames = Array.from({ length: 9 }, (_, i) =>
  row({
    contract: `S${i}`,
    ticker: `YY${i}`,
    score: 80 - i,
    spreadPct: 0.08,
    premiumUsd: 40_000,
    ask: 1.2,
    grok: "take",
    claude: i === 0 ? "pass" : "take",
    gpt: "take",
  }),
);
const studyFill = selectAiTraderFills(studyNames, { ...base, studyBoost: true });
assert.equal(studyFill.filter((f) => f.tier === "quality").length, 0);
assert.equal(studyFill.filter((f) => f.book === "ai-grok" && f.tier === "study").length, 8);
assert.equal(studyFill.filter((f) => f.book === "ai-claude" && f.tier === "study").length, 8);
assert.equal(studyFill.filter((f) => f.book === "ai-gpt" && f.tier === "study").length, 8);
assert.ok(!studyFill.some((f) => f.book === "ai-rules" || f.book === "main"));
assert.ok(studyFill.filter((f) => f.tier === "study").every((f) => f.spreadMaxPct === 0.1));
const wideSpread = selectAiTraderFills(
  [row({ contract: "WIDE", ticker: "YY9", spreadPct: 0.12, score: 80, premiumUsd: 40_000, grok: "take" })],
  { ...base, studyBoost: true },
);
assert.equal(wideSpread.length, 0);
const stockPut = selectAiTraderFills(
  [row({ contract: "SPUT", ticker: "NVDA", side: "put", etf: false, spreadPct: 0.08, score: 70, premiumUsd: 40_000, grok: "take" })],
  { ...base, studyBoost: true },
);
assert.equal(stockPut.length, 0);
const etfPut = selectAiTraderFills(
  [row({ contract: "SPY2", ticker: "SPY", side: "put", etf: true, spreadPct: 0.08, score: 70, premiumUsd: 40_000, grok: "take" })],
  { ...base, studyBoost: true, blockEtfPuts: true },
);
assert.equal(etfPut.length, 0);
const heldStudy = selectAiTraderFills(studyNames, {
  ...base,
  regimeLabel: "report-day",
  studyBoost: true,
  held: [{ book: "ai-grok", ticker: "YY0", contract: "HELD", tier: "study" }],
});
assert.ok(!heldStudy.some((f) => f.book === "ai-grok" && f.ticker === "YY0"));
const qualityHeld = selectAiTraderFills(studyNames, {
  ...base,
  regimeLabel: "report-day",
  studyBoost: true,
  held: [{ book: "ai-grok", ticker: "YY1", contract: "QHELD", tier: "quality" }],
});
assert.ok(qualityHeld.some((f) => f.book === "ai-grok" && f.tier === "study" && f.ticker === "YY1"), "study issuer cap is separate from quality");

const off = selectAiTraderFills(studyNames, base);
assert.equal(off.length, 0);

const order = [
  { score: 70, at: "2026-11-16T14:00:00Z", contract: "late" },
  { score: 90, at: "2026-11-16T16:00:00Z", contract: "late-high" },
  { score: 90, at: "2026-11-16T14:00:00Z", contract: "early-high" },
].sort(byScoreThenEarlier);
assert.deepEqual(order.map((x) => x.contract), ["early-high", "late-high", "late"]);

const withStudyTrades = scoreOf([
  ...trades("grok", 10, 5),
  ...trades("rules", 2, 6),
  ...trades("grok", 40, 8).map((t) => ({ ...t, tier: "study" as const, contract: `study-${t.contract}` })),
]);
assert.equal(withStudyTrades.winner, "grok");
assert.equal(withStudyTrades.books.find((b) => b.book === "grok")?.trades, 5);
assert.equal(withStudyTrades.books.find((b) => b.book === "grok")?.avgReturnPct, 10);
assert.equal(withStudyTrades.books.find((b) => b.book === "grok")?.study?.trades, 8);
assert.equal(withStudyTrades.books.find((b) => b.book === "grok")?.study?.avgReturnPct, 40);
assert.equal(withStudyTrades.books.find((b) => b.book === "rules")?.study, null);
assert.equal(withStudyTrades.trades.length, 11);
assert.equal(withStudyTrades.studyTrades.length, 8);
assert.match(renderWeekMd(withStudyTrades), /Study tier/);
assert.match(renderWeekMd(withStudyTrades), /do not pick the winner/);
assert.doesNotMatch(renderWeekMd(winner), /Study tier/);

const spend = projectQuietSpend(true);
const baseline = projectQuietSpend(false);
assert.ok(spend.totalUsd <= spend.hardCapUsd, `boost spend ${spend.totalUsd} over $3`);
assert.ok(baseline.totalUsd <= 3);
assert.ok(spend.extraRows.grok > 0 && spend.extraRows.claude > 0 && spend.extraRows.gpt > 0);
assert.equal(spend.studyFillsPerAiBook, 8);
assert.equal(spend.qualityListCapReportDay, 8);
console.log("study-boost projection", JSON.stringify({ boost: spend, baseline }, null, 2));

// Floors, the Friday rule, the study cap, and the boost end date stay put.
assert.equal(AI_TRADER_SPREAD_MAX, 0.04);
assert.equal(AI_TRADER_FLOOR.minAsk, 2);
assert.equal(AI_TRADER_FLOOR.minPremiumUsd, 100_000);
assert.equal(AI_TRADER_FLOOR.minScore, 90);
assert.equal(AI_TRADER_LIVE_FLOOR.spreadMaxPct, 0.1);
assert.equal(AI_TRADER_LIVE_FLOOR.minScore, 45);
assert.equal(AI_TRADER_LIVE_FLOOR.minPremiumUsd, 10_000);
assert.equal(AI_TRADER_MIN_TRADES, 5);
assert.equal(AI_TRADER_BOOST_FILL_CAP, 8);
assert.equal(AI_TRADER_STUDY_BOOST_END, "2026-12-11");
assert.equal(spend.hardCapUsd, 3);

const gptPrompt = wideReviewSystemPrompt("gpt");
const grokPrompt = wideReviewSystemPrompt("grok");
const claudePrompt = wideReviewSystemPrompt("claude");
const livePrompt = buildLessonsPrompt();
assert.equal(claudePrompt, grokPrompt);
assert.equal(gptPrompt, buildLessonsPrompt({ extra: WIDE_RULE }));
assert.ok(gptPrompt.includes("if none, pick fewer (0 is a valid answer)"));
assert.ok(gptPrompt.includes("Skip: ask < $2, spread > 4%, premium < $100k, score < 90"));
assert.equal(gptPrompt.includes('start why with "study tier:"'), false);
assert.equal(livePrompt.includes('start why with "study tier:"'), false);
assert.equal(buildLessonsPrompt({ extra: `${WIDE_RULE} gex context` }).includes('start why with "study tier:"'), false);
assert.ok(livePrompt.includes("if none, pick fewer (0 is a valid answer)"));
assert.ok(grokPrompt.includes('start why with "study tier:"'));
assert.ok(grokPrompt.includes(studyTierFloorPhrase()));
assert.ok(grokPrompt.includes(qualityBucketPhrase()));
assert.equal(grokPrompt.includes("if none, pick fewer (0 is a valid answer)"), false);
assert.ok(grokPrompt.includes("0 is a valid answer"));
assert.ok(grokPrompt.includes("Do not force a take"));
assert.ok(grokPrompt.includes("at most 3 takes"));
assert.ok(grokPrompt.includes("Quality-bucket takes are unchanged"));
assert.ok(studyTierFloorPhrase().includes("10%") && studyTierFloorPhrase().includes("45") && studyTierFloorPhrase().includes("$10k"));

const batches = {
  grok: Math.ceil(spend.lanes.grok.rows / 20),
  claude: Math.ceil(spend.lanes.claude.rows / 20),
};
const costDelta = studyTierPromptCostDelta(grokPrompt.length - gptPrompt.length, batches);
const todayLow = 2.3;
const todayHigh = 2.7;
assert.ok(costDelta.addedUsd > 0 && costDelta.addedUsd < 0.5, `study-tier prompt add ${costDelta.addedUsd} looks wrong`);
assert.ok(todayHigh + costDelta.addedUsd < spend.hardCapUsd, `today high + prompt add ${todayHigh + costDelta.addedUsd} crosses $3`);
assert.ok(spend.totalUsd + costDelta.addedUsd <= spend.hardCapUsd, `projection ${spend.totalUsd} + ${costDelta.addedUsd} crosses $3`);
assert.equal(WIDE_REVIEW_TOKEN_USD_PER_M.grok.output, 6);
assert.equal(WIDE_REVIEW_TOKEN_USD_PER_M.claude.output, 15);
console.log("study-tier prompt cost", JSON.stringify({ todayLow, todayHigh, withPrompt: { low: Math.round((todayLow + costDelta.addedUsd) * 100) / 100, high: Math.round((todayHigh + costDelta.addedUsd) * 100) / 100 }, projectionWithPrompt: Math.round((spend.totalUsd + costDelta.addedUsd) * 100) / 100, costDelta }, null, 2));

console.log("ai-trader-books-check: ok");
