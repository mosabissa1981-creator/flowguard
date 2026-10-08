/**
 * LIVE puts rule (approved by Mosab 10/8/2026, 10:39 AM CT): on live boards a PUT is allowed only when the
 * underlying is an ETF or an index. Single-stock puts are excluded from live boards and shown as
 * "Skipped: single-stock put (ETF/index puts only)"; they keep being logged/scored in test mode (study book,
 * puts test lane). Calls are unaffected. Pure logic only (no I/O) so it can be tested.
 *
 * Classification = the one used by scripts/study/puts-bar-backtest.py: the flow alert's issue_type when UW
 * sends one (ETF / Index → allowed, anything else → single stock), else the ETF/index ticker list below.
 */

/** The ONE switch for the live puts rule: "etf_index" = ETF/index puts only; "all" = rule off. */
export const PUTS_ALLOWED_UNDERLYING: "etf_index" | "all" = "etf_index";

/** Fallback when the alert carries no issue_type (same list as the study, plus cash-index roots). */
export const ETF_INDEX_FALLBACK: ReadonlySet<string> = new Set([
  "SPY", "QQQ", "IWM", "DIA", "SMH", "SOXX", "XLF", "XLE", "XLK", "XLV", "XLY", "XLI", "XLP", "XLU", "XLB", "XLC", "XLRE",
  "KRE", "XBI", "GLD", "SLV", "TLT", "HYG", "EEM", "FXI", "KWEB", "ARKK", "IBIT", "ETHA", "USO", "UNG", "GDX", "TQQQ", "SQQQ",
  "SOXL", "SOXS", "UVXY", "VXX", "EWZ", "IYR", "XOP", "XRT", "JETS", "BITO", "MSTU", "TSLL", "NVDL",
  // Cash indexes (index options).
  "SPX", "SPXW", "NDX", "NDXP", "RUT", "RUTW", "VIX", "VIXW", "XSP", "DJX", "OEX", "XEO",
]);

export const SINGLE_STOCK_PUT_REASON = "Skipped: single-stock put (ETF/index puts only)";

/** ETF or index underlying? issue_type wins when present; otherwise the ticker list. */
export function isEtfOrIndex(ticker: string | null | undefined, issueType?: string | null): boolean {
  const it = (issueType ?? "").trim();
  if (it) return /etf|index/i.test(it);
  return ETF_INDEX_FALLBACK.has((ticker ?? "").trim().toUpperCase());
}

/** True when the live puts rule blocks this contract (single-stock put while the rule is on). Calls → false. */
export function blockedByPutsRule(
  side: string | null | undefined,
  ticker: string | null | undefined,
  issueType?: string | null,
  allowed: "etf_index" | "all" = PUTS_ALLOWED_UNDERLYING,
): boolean {
  if (allowed === "all") return false;
  if ((side ?? "").toLowerCase() !== "put") return false;
  return !isEtfOrIndex(ticker, issueType);
}
