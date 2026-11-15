/** Pure checks for the AI-trader paper books. Run: npm run ai-trader-books-check */
import assert from "node:assert/strict";

import {
  AI_TRADER_MIN_TRADES,
  applyDayCaps,
  askClearsFloor,
  bidFromAskSpread,
  buildWeekScore,
  capsForRegime,
  isFridayAfterClose,
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

console.log("ai-trader-books-check: ok");
