/**
 * Checks for the TEST-mode GPT third-opinion lane wiring.
 * Usage: npx tsx --conditions=react-server scripts/gpt-third-check.ts
 * Optional: DRY_RUN=1 REVIEW_LIMIT=20 … [day]  (needs OPENAI_API_KEY)
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { TEST_MODE_GROK_DAY_CAP_USD, TEST_MODE_GROK_SCOPES, testModeGrokBatchFits } from "../lib/llm-ledger";
import { lessonsSystemPrompt } from "../lib/shadow/lessons-review";
import { estimateCost, openaiLlmConfig } from "../lib/shadow/llm";
import { parseBatch, WIDE_RULE } from "../lib/shadow/wide-pool";
import { wideFactLine, type WideCandidate, type WideJudgement } from "../lib/shadow/wide-pool-core";
import { gptThirdEnabled, gptThirdLimits } from "../lib/shadow/gpt-third";

assert.ok((TEST_MODE_GROK_SCOPES as readonly string[]).includes("gpt-third"), "gpt-third in quiet scopes");
assert.ok((TEST_MODE_GROK_SCOPES as readonly string[]).includes("claude-second"), "claude-second still in quiet scopes");
assert.equal(TEST_MODE_GROK_DAY_CAP_USD, 3);
assert.equal(testModeGrokBatchFits(2.9, 0.05), true);
assert.equal(testModeGrokBatchFits(2.5, 0.6), false);
const limits = gptThirdLimits();
assert.ok(limits.usdCap <= 0.75 && limits.usdCap >= 0.5, `usdCap ${limits.usdCap}`);
console.log("ledger/limits: ok", limits);

const cfg = openaiLlmConfig();
if (!cfg) {
  console.log("openai config: absent (lane will no-op) — OK");
  assert.equal(gptThirdEnabled(), false, "enabled false without key (or wide off)");
} else {
  assert.equal(cfg.provider, "openai");
  assert.ok(cfg.model.length > 0);
  assert.equal(cfg.searchEnabled, false);
  console.log(`openai config: ok (model=${cfg.model})`);
}

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
assert.ok(wideFactLine(sample).includes("TEST261120C00100000"));
const fake = parseBatch(
  JSON.stringify({ reviews: [{ contract: sample.contract, judge: "pass", confidence: 40, why: "unit" }] }),
  [sample],
  new Date().toISOString(),
);
assert.equal(fake[sample.contract]?.judge, "pass");
console.log("parse/fact: ok");

async function dryRun(day: string) {
  if (!cfg) throw new Error("OPENAI_API_KEY required for DRY_RUN");
  const study = process.env.STUDY_DIR ?? "/workspace/flowguard/study";
  const gexPath = `${study}/grok-gex-dex-${day}.json`;
  if (!existsSync(gexPath)) throw new Error(`no ${gexPath}`);
  const doc = JSON.parse(readFileSync(gexPath, "utf8")) as {
    rows?: Array<{ contract: string; candidate: WideCandidate | null; grok: WideJudgement | null }>;
  };
  const limit = Math.max(1, Math.min(60, Number(process.env.REVIEW_LIMIT) || 20));
  const batch = (doc.rows ?? []).filter((r) => r.candidate && r.grok).slice(0, limit);
  assert.ok(batch.length > 0);
  const system = lessonsSystemPrompt(WIDE_RULE);
  const user = `As of ${new Date().toISOString()}. Candidates:\n${batch.map((r) => wideFactLine(r.candidate!)).join("\n")}`;
  const ceiling = estimateCost(cfg.model, Math.ceil((system.length + user.length) / 3), 0, 1500 + batch.length * 250, 0, 0);
  console.log(`calling GPT ${cfg.model} on ${batch.length} rows (ceiling ~$${ceiling.toFixed(4)})…`);
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`openai ${res.status}: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  const inTok = json.usage?.prompt_tokens ?? 0;
  const outTok = json.usage?.completion_tokens ?? 0;
  const cost = estimateCost(cfg.model, inTok, 0, outTok, 0, 0);
  const judgements = parseBatch(text, batch.map((r) => r.candidate!), new Date().toISOString());
  let agree = 0, gptTakes = 0, grokTakes = 0;
  for (const r of batch) {
    const gj = r.grok, cj = judgements[r.contract];
    if (!cj || !gj) continue;
    if (cj.judge === "take") gptTakes += 1;
    if (gj.judge === "take") grokTakes += 1;
    if (cj.judge === gj.judge) agree += 1;
  }
  const out = {
    day, mode: "test" as const, lane: "gpt-third-dry-run",
    model: json.model ?? cfg.model, costUsd: cost, tokens: { in: inTok, out: outTok },
    compare: { rows: batch.length, agree, gptTakes, grokTakes },
  };
  mkdirSync(study, { recursive: true });
  const path = `${study}/gpt-third-dryrun-${day}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.compare), `cost $${cost.toFixed(4)} -> ${path}`);
}

const day = process.argv[2] ?? "2026-11-05";
if (process.env.DRY_RUN === "1") {
  dryRun(day).catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log(`dry-run: skipped (set DRY_RUN=1 + OPENAI_API_KEY to call GPT on ${day})`);
}
