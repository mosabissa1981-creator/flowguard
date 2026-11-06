/**
 * Checks for the TEST-mode Claude second-opinion lane wiring (no live LLM/UW unless DRY_RUN=1).
 * Usage: npx tsx --conditions=react-server scripts/claude-second-check.ts
 * Optional: DRY_RUN=1 REVIEW_LIMIT=20 npx tsx --conditions=react-server scripts/claude-second-check.ts [day]
 *   dry-runs Claude on a sample of study/grok-gex-dex-<day>.json rows (charges Anthropic; keep small).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { TEST_MODE_GROK_DAY_CAP_USD, TEST_MODE_GROK_SCOPES, testModeGrokBatchFits } from "../lib/llm-ledger";
import { lessonsSystemPrompt } from "../lib/shadow/lessons-review";
import { anthropicLlmConfig, estimateCost } from "../lib/shadow/llm";
import { parseBatch, WIDE_RULE } from "../lib/shadow/wide-pool";
import { wideFactLine, type WideCandidate, type WideJudgement } from "../lib/shadow/wide-pool-core";

assert.ok((TEST_MODE_GROK_SCOPES as readonly string[]).includes("claude-second"), "claude-second in quiet scopes");
assert.equal(TEST_MODE_GROK_DAY_CAP_USD, 3);
assert.equal(testModeGrokBatchFits(2.9, 0.05), true);
assert.equal(testModeGrokBatchFits(2.9, 0.2), false);
assert.equal(testModeGrokBatchFits(3, 0.01), false);
console.log("ledger: ok");

const cfg = anthropicLlmConfig();
assert.ok(cfg, "ANTHROPIC_API_KEY must be set for this check");
assert.equal(cfg.provider, "anthropic");
assert.ok(cfg.model.length > 0);
assert.equal(cfg.searchEnabled, false);
console.log(`anthropic config: ok (model=${cfg.model})`);

const sample: WideCandidate = {
  contract: "TEST261120C00100000",
  ticker: "TEST",
  side: "call",
  strike: 100,
  expiry: "2026-11-20",
  dte: 14,
  underlying: 100,
  entry: 1.25,
  spreadPct: 0.05,
  etf: false,
  askSharePct: 90,
  premiumUsd: 250_000,
  volOi: 5,
  sweep: true,
  score: 80,
  rawScore: 80,
  tier: "pool",
  chips: ["ask-dom"],
  printTimeUtc: "2026-11-05T15:30:00.000Z",
  firstSeenAt: "2026-11-05T15:30:00.000Z",
};
const line = wideFactLine(sample);
assert.ok(line.includes("TEST261120C00100000") && line.includes("sweep"));
const fake = parseBatch(
  JSON.stringify({
    reviews: [
      { contract: sample.contract, judge: "take", confidence: 70, why: "unit" },
      { contract: "OTHER", judge: "take", confidence: 99, why: "ignored" },
    ],
  }),
  [sample],
  new Date().toISOString(),
);
assert.equal(fake[sample.contract]?.judge, "take");
assert.equal(Object.keys(fake).length, 1);
console.log("parse/fact: ok");

async function dryRun(day: string) {
  const study = process.env.STUDY_DIR ?? "/workspace/flowguard/study";
  const gexPath = `${study}/grok-gex-dex-${day}.json`;
  if (!existsSync(gexPath)) {
    console.log(`no ${gexPath}; cannot dry-run`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(gexPath, "utf8")) as {
    rows?: Array<{ contract: string; candidate: WideCandidate | null; grok: WideJudgement | null }>;
  };
  const rows = doc.rows ?? [];
  console.log(`loaded ${rows.length} rows from ${gexPath}`);
  const limit = Math.max(1, Math.min(60, Number(process.env.REVIEW_LIMIT) || 20));
  const batch = rows.filter((r) => r.candidate && r.grok).slice(0, limit);
  assert.ok(batch.length > 0, "need judged wide rows");
  const system = lessonsSystemPrompt(WIDE_RULE);
  const user = `As of ${new Date().toISOString()}. Candidates:\n${batch.map((r) => wideFactLine(r.candidate!)).join("\n")}`;
  const ceiling = estimateCost(cfg!.model, Math.ceil((system.length + user.length) / 3), 0, 1500 + batch.length * 250, 0, 0);
  console.log(`calling Claude ${cfg!.model} on ${batch.length} rows (ceiling ~$${ceiling.toFixed(4)})…`);

  const res = await fetch(`${cfg!.baseUrl}/messages`, {
    method: "POST",
    headers: { "x-api-key": cfg!.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg!.model,
      max_tokens: 2500,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw) as {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
  };
  const text = (json.content ?? []).map((c) => c.text ?? "").join("");
  const inTok = json.usage?.input_tokens ?? 0;
  const outTok = json.usage?.output_tokens ?? 0;
  const cost = estimateCost(cfg!.model, inTok, 0, outTok, 0, 0);
  const judgements = parseBatch(
    text,
    batch.map((r) => r.candidate!),
    new Date().toISOString(),
  );
  let agree = 0;
  let claudeTakes = 0;
  let grokTakes = 0;
  const disagreements: Array<{ contract: string; claude: string; grok: string; why: string }> = [];
  for (const r of batch) {
    const cj = judgements[r.contract];
    const gj = r.grok;
    if (!cj || !gj) continue;
    if (cj.judge === "take") claudeTakes += 1;
    if (gj.judge === "take") grokTakes += 1;
    if (cj.judge === gj.judge) agree += 1;
    else disagreements.push({ contract: r.contract, claude: cj.judge, grok: gj.judge, why: cj.why });
  }
  const out = {
    day,
    mode: "test" as const,
    lane: "claude-second-dry-run",
    note: "Box dry-run only; not the live lane doc. Screener study, not financial advice.",
    model: json.model ?? cfg!.model,
    costUsd: cost,
    tokens: { in: inTok, out: outTok },
    compare: { rows: batch.length, agree, claudeTakes, grokTakes, disagreements: disagreements.length },
    disagreements: disagreements.slice(0, 20),
    judgements,
  };
  mkdirSync(study, { recursive: true });
  const outPath = `${study}/claude-second-dryrun-${day}.json`;
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.compare, null, 2));
  console.log(`cost $${cost.toFixed(4)} (${inTok} in / ${outTok} out) -> ${outPath}`);
  if (disagreements[0]) console.log("sample disagree:", disagreements[0]);
}

const day = process.argv[2] ?? "2026-11-05";
if (process.env.DRY_RUN === "1") {
  dryRun(day).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.log(`dry-run: skipped (set DRY_RUN=1 to call Claude on ${day})`);
}
