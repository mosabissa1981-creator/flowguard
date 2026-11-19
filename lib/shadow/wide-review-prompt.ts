import { AI_TRADER_FLOOR, AI_TRADER_LIVE_FLOOR } from "@/lib/ai-trader-books-core";
import { GROK_LESSONS_EXAMPLES, GROK_LESSONS_SHEET } from "@/lib/shadow/grok-lessons";
import { GROK_LESSONS_WEEKLY } from "@/lib/shadow/grok-lessons-weekly";

/**
 * TEST MODE ONLY. System prompt for the wide-pool reviewers.
 * GPT keeps the shared lessons sheet (it already takes study-tier rows).
 * Grok and Claude get the same sheet with the "skip anything outside the quality bucket" lines
 * rewritten, plus a study-tier section, so they may take those rows and label them.
 * Live lessons review and the GEX/DEX lane do not use the study-tier wording.
 */

export const WIDE_RULE =
  "These candidates are a WIDE study pool: setups the live lists ranked below their cut (lanes=wide-pool+pool) or just under the score floor (wide-pool+near-miss), judged only so the desk learns.";

/** GPT's observed take count on a ~600-row day. A selectivity target, not a quota. */
export const WIDE_STUDY_TAKE_AIM = 14;
export const WIDE_STUDY_ROWS_PER_DAY = 600;

/** List prices (USD / 1M tokens), same figures as lib/shadow/llm.ts for the two wide-pool models. */
export const WIDE_REVIEW_TOKEN_USD_PER_M = {
  grok: { input: 2, output: 6 },
  claude: { input: 3, output: 15 },
} as const;

const SYSTEM = [
  "You are the risk-aware desk reviewer for FlowGuard, an unusual-options-flow screener (paper-trading study, not financial advice).",
  "You do NOT predict prices. For each candidate say take or pass. Most should be pass: take at most 3 and never two from one issuer.",
  "Trades are bought at the ask and exited at +30% target, -25% stop, or after 2 sessions. Use the lessons sheet and real examples below.",
  'Return JSON only: {"reviews":[{"contract":"","judge":"take|pass","confidence":0-100,"why":"<=120 chars"}]}',
].join(" ");

const QUALITY_BUCKET_LINE = "1. Prefer candidates in the quality bucket; if none, pick fewer (0 is a valid answer).";
const QUALITY_SKIP_LINE =
  "3. Skip: ask < $2, spread > 4%, premium < $100k, score < 90, late-morning lone prints, single-stock puts, DTE 46+. Do NOT skip just because the ask is above $10 or DTE is 31-45.";

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function premiumLabel(usd: number): string {
  return usd >= 1000 && usd % 1000 === 0 ? `$${Math.round(usd / 1000)}k` : `$${usd}`;
}

/** Live floor, the study-tier definition already used by the paper books. */
export function studyTierFloorPhrase(): string {
  return `spread ≤ ${pct(AI_TRADER_LIVE_FLOOR.spreadMaxPct)}, score ≥ ${AI_TRADER_LIVE_FLOOR.minScore}, and premium ≥ ${premiumLabel(AI_TRADER_LIVE_FLOOR.minPremiumUsd)}`;
}

export function qualityBucketPhrase(): string {
  return `spread ≤ ${pct(AI_TRADER_FLOOR.spreadMaxPct)}, ask ≥ $${AI_TRADER_FLOOR.minAsk}, premium ≥ ${premiumLabel(AI_TRADER_FLOOR.minPremiumUsd)}, score ≥ ${AI_TRADER_FLOOR.minScore}`;
}

function studyTierSection(): string {
  const floor = studyTierFloorPhrase();
  const quality = qualityBucketPhrase();
  return [
    "## Study tier for this review",
    "This section overrides the lessons lines that say to skip anything outside the quality bucket, and the line that says 0 is the answer when nothing is in that bucket. It does not change how you judge a quality-bucket row.",
    `A row is study tier when it misses the quality bucket (${quality}) and still clears the live floor: ${floor}. There is no $${AI_TRADER_FLOOR.minAsk} ask minimum on a study-tier row. When you take one, start why with "study tier:". Do not put that label on a quality-bucket take.`,
    `You may take a study-tier row. Prefer the cleaner ones on the other facts (tighter spread, earlier print, repeat flow, not a lone cheap print). Stay as selective as a reviewer who takes about 13 to ${WIDE_STUDY_TAKE_AIM} rows out of about ${WIDE_STUDY_ROWS_PER_DAY} in a day. That count is not a quota: do not force a take, and 0 is a valid answer when the batch is weak. Most rows are still pass.`,
    "The batch cap is unchanged: at most 3 takes, never two from one issuer.",
    `Quality-bucket takes are unchanged. Still pass a row you are judging as quality when spread is over ${pct(AI_TRADER_FLOOR.spreadMaxPct)}, ask is under $${AI_TRADER_FLOOR.minAsk}, premium is under ${premiumLabel(AI_TRADER_FLOOR.minPremiumUsd)}, or score is under ${AI_TRADER_FLOOR.minScore}.`,
    `Pass a row that misses the live floor: spread over ${pct(AI_TRADER_LIVE_FLOOR.spreadMaxPct)}, score under ${AI_TRADER_LIVE_FLOOR.minScore}, or premium under ${premiumLabel(AI_TRADER_LIVE_FLOOR.minPremiumUsd)}.`,
  ].join("\n");
}

/** Rewrites only the two lessons lines that tell a reviewer to skip every non-quality row. */
export function lessonsSheetForStudyTier(sheet: string): string {
  if (!sheet.includes(QUALITY_BUCKET_LINE) || !sheet.includes(QUALITY_SKIP_LINE)) {
    throw new Error("lessons sheet is missing the quality-bucket lines the study-tier prompt rewrites");
  }
  const prefer =
    "1. Prefer candidates in the quality bucket. You may also take a study-tier row (defined at the end of this prompt) and label it study tier. If a batch has nothing you would take in either bucket, pick fewer (0 is a valid answer). Do not force a take.";
  const skip =
    "3. Quality-bucket takes still skip ask < $2, spread > 4%, premium < $100k, and score < 90. A study-tier take may miss that bucket when it clears the live floor at the end of this prompt. Still skip late-morning lone prints, single-stock puts, and DTE 46+. Do NOT skip just because the ask is above $10 or DTE is 31-45.";
  return sheet.replace(QUALITY_BUCKET_LINE, prefer).replace(QUALITY_SKIP_LINE, skip);
}

export function buildLessonsPrompt(opts?: { extra?: string; studyTier?: boolean }): string {
  const studyTier = Boolean(opts?.studyTier);
  const sheet = studyTier ? lessonsSheetForStudyTier(GROK_LESSONS_SHEET) : GROK_LESSONS_SHEET;
  const weekly = GROK_LESSONS_WEEKLY.trim();
  const extra = opts?.extra?.trim() ? ` ${opts.extra.trim()}` : "";
  const tail = studyTier ? `\n\n${studyTierSection()}` : "";
  return `${SYSTEM}${extra}\n\n${sheet}${weekly ? `\n\n${weekly}` : ""}\n\n${GROK_LESSONS_EXAMPLES}${tail}`;
}

const STUDY_TIER_OPENING =
  'You may take a study-tier row and label that take "study tier". The study-tier section at the end of this prompt overrides the lessons lines that say to skip anything outside the quality bucket. Quality-bucket judgement is unchanged. Do not force a take.';

export type WideReviewer = "grok" | "claude" | "gpt";

export function wideReviewerAllowsStudyTier(lane: WideReviewer): boolean {
  return lane === "grok" || lane === "claude";
}

/** System prompt actually sent to one wide-pool reviewer. GPT stays on the shared sheet. */
export function wideReviewSystemPrompt(lane: WideReviewer): string {
  if (!wideReviewerAllowsStudyTier(lane)) return buildLessonsPrompt({ extra: WIDE_RULE });
  return buildLessonsPrompt({ extra: `${WIDE_RULE} ${STUDY_TIER_OPENING}`, studyTier: true });
}

export type StudyTierCostDelta = {
  extraChars: number;
  extraInputTokensPerBatch: number;
  grokBatches: number;
  claudeBatches: number;
  extraInputUsd: number;
  /** 10% more output on an assumed 800 tokens/batch, plus a short "study tier:" label on the aimed takes. */
  extraOutputUsd: number;
  addedUsd: number;
};

const CHARS_PER_TOKEN = 3;
const OUTPUT_TOKENS_PER_BATCH = 800;
const OUTPUT_BUMP = 0.1;
const LABEL_TOKENS_PER_TAKE = 20;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Extra quiet-test dollars if Grok and Claude send the longer study-tier prompt.
 * Input uses the same chars/3 count as reviewBatchCeiling. Output is a small cushion, not a new lane.
 */
export function studyTierPromptCostDelta(extraChars: number, batches: { grok: number; claude: number }): StudyTierCostDelta {
  const extraInputTokensPerBatch = Math.ceil(Math.max(0, extraChars) / CHARS_PER_TOKEN);
  const prices = WIDE_REVIEW_TOKEN_USD_PER_M;
  const inputUsd =
    (batches.grok * extraInputTokensPerBatch * prices.grok.input + batches.claude * extraInputTokensPerBatch * prices.claude.input) / 1e6;
  const outputTokens = (n: number) => n * OUTPUT_TOKENS_PER_BATCH * OUTPUT_BUMP + WIDE_STUDY_TAKE_AIM * LABEL_TOKENS_PER_TAKE;
  const outputUsd = (outputTokens(batches.grok) * prices.grok.output + outputTokens(batches.claude) * prices.claude.output) / 1e6;
  const extraInputUsd = round4(inputUsd);
  const extraOutputUsd = round4(outputUsd);
  return {
    extraChars,
    extraInputTokensPerBatch,
    grokBatches: batches.grok,
    claudeBatches: batches.claude,
    extraInputUsd,
    extraOutputUsd,
    addedUsd: round4(extraInputUsd + extraOutputUsd),
  };
}
