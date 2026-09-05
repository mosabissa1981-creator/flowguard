import type {
  EvaluatedWatch,
  OptionType,
  PriceWatch,
  PriceWatchKind,
  WatchAlert,
  WatchAlertHint,
  WatchCheckResponse,
  WatchQuote,
} from "@/lib/types";
import { formatExpiry, formatStrike } from "@/lib/format";
import { printAgeBand } from "@/lib/session";
import { watchLifecycle, type HistoricBar } from "@/lib/follow-through";

export const PRICE_WATCHES_KEY = "flowguard.priceWatches";
export const EMPTY_PRICE_WATCHES: PriceWatch[] = [];

export const DEFAULT_ADVERSE_PCT = 0.15;
export const DEFAULT_APPROACH_PCT = 0.05;

export function contractLabel(watch: {
  ticker: string;
  strike: string;
  expiry: string;
  type: OptionType;
}): string {
  return `${watch.ticker} ${formatStrike(watch.strike)}${watch.type === "put" ? "P" : "C"} ${formatExpiry(watch.expiry)}`;
}

export function watchId(kind: PriceWatchKind, optionChain: string): string {
  return `${kind}:${optionChain}`;
}

export function makeAdverseWatch(input: {
  ticker: string;
  option_chain: string;
  strike: string;
  expiry: string;
  type: OptionType;
  entryPremium: number;
  adversePct?: number;
  stopPremium?: number;
  lastFlowPrint?: number;
  referenceSource?: PriceWatch["referenceSource"];
}): PriceWatch {
  return {
    id: watchId("adverse", input.option_chain),
    kind: "adverse",
    ticker: input.ticker.toUpperCase(),
    option_chain: input.option_chain,
    strike: input.strike,
    expiry: input.expiry,
    type: input.type,
    referencePremium: input.entryPremium,
    referenceSource: input.referenceSource,
    adversePct: input.adversePct ?? DEFAULT_ADVERSE_PCT,
    approachPct: DEFAULT_APPROACH_PCT,
    stopPremium: input.stopPremium,
    lastFlowPrint: input.lastFlowPrint,
    createdAt: new Date().toISOString(),
  };
}

export function makeEntryWatch(input: {
  ticker: string;
  option_chain: string;
  strike: string;
  expiry: string;
  type: OptionType;
  targetPremium: number;
  approachPct?: number;
  lastFlowPrint?: number;
  referenceSource?: PriceWatch["referenceSource"];
}): PriceWatch {
  return {
    id: watchId("entry_approach", input.option_chain),
    kind: "entry_approach",
    ticker: input.ticker.toUpperCase(),
    option_chain: input.option_chain,
    strike: input.strike,
    expiry: input.expiry,
    type: input.type,
    referencePremium: input.targetPremium,
    referenceSource: input.referenceSource,
    adversePct: DEFAULT_ADVERSE_PCT,
    approachPct: input.approachPct ?? DEFAULT_APPROACH_PCT,
    lastFlowPrint: input.lastFlowPrint,
    createdAt: new Date().toISOString(),
  };
}

export function upsertWatch(list: PriceWatch[], watch: PriceWatch): PriceWatch[] {
  const without = list.filter((item) => item.id !== watch.id);
  return [...without, watch];
}

function agedWatchHint(watch: PriceWatch, now?: Date): string | null {
  if (!watch.createdAt) return null;
  const band = printAgeBand(watch.createdAt, now);
  if (band !== "aged" && band !== "stale") return null;
  return watch.type === "call"
    ? "aged call watch — Sep 4 book faded these"
    : "aged watch — conviction should already be fading";
}

export function evaluateWatch(
  watch: PriceWatch,
  quote: WatchQuote | null,
  context: { historic?: HistoricBar[] | null; now?: Date } = {},
): EvaluatedWatch {
  const now = context.now ?? new Date();
  const life = watchLifecycle(watch, quote?.last, context.historic, now);
  const followed =
    quote != null &&
    quote.last > 0 &&
    watch.referencePremium > 0 &&
    quote.last >= watch.referencePremium * 1.05;
  const ageHint = life.hint ?? (followed ? null : agedWatchHint(watch, now));

  if (!quote || !(quote.last > 0) || !(watch.referencePremium > 0)) {
    if (life.expired) {
      return {
        watch,
        quote,
        status: "expired",
        pctMove: null,
        hint: life.hint,
        expired: true,
        fading: true,
      };
    }
    return { watch, quote, status: "ok", pctMove: null, hint: ageHint, fading: life.fading };
  }

  const last = quote.last;
  const reference = watch.referencePremium;
  const pctMove = (last - reference) / reference;

  if (watch.kind === "adverse") {
    const band = Math.max(0.01, Math.min(0.9, watch.adversePct));
    const adverseLevel = reference * (1 - band);
    const stop = watch.stopPremium && watch.stopPremium > 0 ? watch.stopPremium : null;
    const hitStop = stop != null && last <= stop;
    const hitPct = last <= adverseLevel;
    if (hitStop || hitPct) {
      return { watch, quote, status: "adverse", pctMove, hint: "consider cutting", fading: true };
    }
    const nearStop = stop != null && last <= stop * 1.05;
    const nearPct = last <= adverseLevel * 1.05;
    if (nearStop || nearPct) {
      return {
        watch,
        quote,
        status: life.expired ? "expired" : "approaching",
        pctMove,
        hint: life.expired ? life.hint : "consider cutting",
        expired: life.expired,
        fading: true,
      };
    }
  } else {
    const band = Math.max(0.005, Math.min(0.5, watch.approachPct));
    if (Math.abs(pctMove) <= band && !life.expired && !life.fading) {
      return { watch, quote, status: "approaching", pctMove, hint: "approaching entry" };
    }
  }

  if (life.expired) {
    return {
      watch,
      quote,
      status: "expired",
      pctMove,
      hint: life.hint,
      expired: true,
      fading: true,
    };
  }
  if (life.fading) {
    return {
      watch,
      quote,
      status: "fading",
      pctMove,
      hint: life.hint ?? "thesis fading",
      fading: true,
    };
  }
  if (watch.kind === "entry_approach") {
    const band = Math.max(0.005, Math.min(0.5, watch.approachPct));
    if (Math.abs(pctMove) <= band) {
      return { watch, quote, status: "approaching", pctMove, hint: "approaching entry" };
    }
  }
  return { watch, quote, status: "ok", pctMove, hint: ageHint };
}

function alertHint(evaluation: EvaluatedWatch): WatchAlertHint {
  if (evaluation.status === "expired") return "watch expired";
  if (evaluation.status === "fading") return "thesis fading";
  if (evaluation.watch.kind === "entry_approach") return "approaching entry";
  return "consider cutting";
}

export function toWatchAlert(evaluation: EvaluatedWatch): WatchAlert | null {
  if (evaluation.status === "ok") return null;
  if (evaluation.status === "expired" || evaluation.status === "fading") {
    return {
      watchId: evaluation.watch.id,
      ticker: evaluation.watch.ticker,
      contract: contractLabel(evaluation.watch),
      option_chain: evaluation.watch.option_chain,
      type: evaluation.watch.kind,
      last: evaluation.quote?.last ?? 0,
      reference: evaluation.watch.referencePremium,
      pctMove: evaluation.pctMove ?? 0,
      status: evaluation.status,
      hint: alertHint(evaluation),
      dataQuality: evaluation.quote?.quality ?? "flow_print",
    };
  }
  if (!evaluation.quote || evaluation.pctMove == null) return null;
  return {
    watchId: evaluation.watch.id,
    ticker: evaluation.watch.ticker,
    contract: contractLabel(evaluation.watch),
    option_chain: evaluation.watch.option_chain,
    type: evaluation.watch.kind,
    last: evaluation.quote.last,
    reference: evaluation.watch.referencePremium,
    pctMove: evaluation.pctMove,
    status: evaluation.status,
    hint: alertHint(evaluation),
    dataQuality: evaluation.quote.quality,
  };
}

export function buildCheckResponse(
  evaluations: EvaluatedWatch[],
  checkedAt = new Date().toISOString(),
): WatchCheckResponse {
  return {
    checkedAt,
    evaluations,
    alerts: evaluations.map(toWatchAlert).filter((item): item is WatchAlert => item != null),
  };
}

export function parsePremiumInput(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== "string") return null;
  const n = Number(raw.trim().replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function parsePctInput(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(/%/g, ""));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 1 ? n / 100 : n;
}

export function isPriceWatch(value: unknown): value is PriceWatch {
  if (!value || typeof value !== "object") return false;
  const row = value as PriceWatch;
  return (
    (row.kind === "adverse" || row.kind === "entry_approach") &&
    typeof row.id === "string" &&
    typeof row.ticker === "string" &&
    typeof row.option_chain === "string" &&
    typeof row.referencePremium === "number" &&
    row.referencePremium > 0
  );
}
