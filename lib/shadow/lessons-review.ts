import "server-only";

import { GROK_LESSONS_EXAMPLES, GROK_LESSONS_SHEET } from "@/lib/shadow/grok-lessons";
import { callShadowLlm, parseJsonObject } from "@/lib/shadow/llm";
import type { LlmUsageRecord, ShadowCandidate, ShadowVerdict } from "@/lib/shadow/types";

/**
 * TEST MODE ONLY. "Grok + lessons" second opinion on the shadow finalists. Grok cannot be fine-tuned, so the 2-year lessons sheet
 * and a few real past winner/loser examples ride in the prompt. The result is logged as a shadow verdict (module lessons_review)
 * and scored in the study book next to the other modules. It NEVER changes morning / picks / premove / ai-picks, never sends
 * Telegram, and is OFF unless FLOWGUARD_LESSONS_TEST=1 (default off). Costs go through the shared shadow LLM ledger/budget.
 */
export type LessonsJudgement = { contract: string; judge: "take" | "pass"; confidence: number; why: string; at: string };

export function lessonsTestEnabled(): boolean {
  return process.env.FLOWGUARD_LESSONS_TEST === "1";
}

const SYSTEM = [
  "You are the risk-aware desk reviewer for FlowGuard, an unusual-options-flow screener (paper-trading study, not financial advice).",
  "You do NOT predict prices. For each candidate say take or pass. Most should be pass: take at most 3 and never two from one issuer.",
  "Trades are bought at the ask and exited at +30% target, -25% stop, or after 2 sessions. Use the lessons sheet and real examples below.",
  'Return JSON only: {"reviews":[{"contract":"","judge":"take|pass","confidence":0-100,"why":"<=120 chars"}]}',
].join(" ");

function factLine(c: ShadowCandidate): string {
  const ct = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(c.printTimeUtc));
  return `${c.contract} | ${c.ticker} ${c.side} K${c.strike} dte${c.dte} px${c.underlying} ask$${c.optionPrint} premium$${Math.round(c.premiumUsd / 1000)}k askShare${c.askSharePct}% score${Math.round(c.rawScore)} lanes=${c.lanes.join("+")} t=${ct}CT`;
}

export async function runLessonsReview(cands: ShadowCandidate[], now: Date): Promise<{ results: Record<string, LessonsJudgement>; usage: LlmUsageRecord }> {
  const system = `${SYSTEM}\n\n${GROK_LESSONS_SHEET}\n\n${GROK_LESSONS_EXAMPLES}`;
  const user = `As of ${now.toISOString()}. Candidates:\n${cands.map(factLine).join("\n")}`;
  const res = await callShadowLlm({ module: "lessons_review", system, user });
  const parsed = parseJsonObject<{ reviews?: Array<Record<string, unknown>> }>(res.text);
  const keys = new Set(cands.map((c) => c.contract));
  const results: Record<string, LessonsJudgement> = {};
  const at = new Date().toISOString();
  for (const r of parsed?.reviews ?? []) {
    const contract = String(r.contract ?? "").trim();
    if (!keys.has(contract)) continue;
    results[contract] = {
      contract,
      judge: String(r.judge) === "take" ? "take" : "pass",
      confidence: Math.max(0, Math.min(100, Number(r.confidence) || 0)),
      why: String(r.why ?? "").slice(0, 200),
      at,
    };
  }
  return { results, usage: res.usage };
}

export function lessonsVerdict(r: LessonsJudgement | undefined): ShadowVerdict {
  const at = new Date().toISOString();
  if (!r) return { module: "lessons_review", verdict: "skip", score: null, confidence: 0, reason: "Lessons review off or not run (test mode only).", at };
  return {
    module: "lessons_review",
    verdict: r.judge === "take" ? "boost" : "pass",
    score: r.judge === "take" ? 1 : 0,
    confidence: r.confidence,
    reason: `Grok+lessons ${r.judge.toUpperCase()}: ${r.why}`.slice(0, 300),
    at: r.at,
  };
}
