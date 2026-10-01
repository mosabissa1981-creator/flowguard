/**
 * Issuer + sector map for concentration caps and the rate-pressure penalty.
 * Static on purpose: zero UW calls. Unknown tickers are their own issuer and
 * fall into an "Other:<ticker>" sector so they never trip the sector cap.
 */

const ISSUER_ALIASES: Record<string, string> = {
  GOOG: "GOOGL",
  GOOGL: "GOOGL",
  "BRK.A": "BRK",
  "BRK.B": "BRK",
  BRKB: "BRK",
  FOX: "FOXA",
  FOXA: "FOXA",
  NWS: "NWSA",
  NWSA: "NWSA",
  // Index products on the same underlying basket count as one issuer.
  QQQ: "NDX",
  QQQM: "NDX",
  TQQQ: "NDX",
  SQQQ: "NDX",
  QLD: "NDX",
  NDX: "NDX",
  SPY: "SPX",
  SPX: "SPX",
  SPXW: "SPX",
  VOO: "SPX",
  IVV: "SPX",
  SPXL: "SPX",
  UPRO: "SPX",
  SPXS: "SPX",
  SH: "SPX",
  IWM: "RUT",
  TNA: "RUT",
  TZA: "RUT",
  TLT: "UST-LONG",
  TMF: "UST-LONG",
  TBT: "UST-LONG",
};

const SECTORS: Record<string, string[]> = {
  "Mega-cap tech": ["AAPL", "MSFT", "GOOGL", "META", "AMZN", "NFLX"],
  Semis: [
    "NVDA", "AMD", "INTC", "AVGO", "MU", "QCOM", "TSM", "ARM", "SMCI", "MRVL", "AMAT", "LRCX",
    "KLAC", "ASML", "ON", "TXN", "ADI", "MCHP", "SOXL", "SOXS", "SMH", "SOXX", "WDC", "STX",
  ],
  Software: [
    "CRM", "ORCL", "NOW", "ADBE", "PLTR", "SNOW", "MDB", "NET", "CRWD", "PANW", "ZS", "DDOG",
    "SHOP", "APP", "INTU", "WDAY", "TEAM", "HUBS", "U", "RBLX", "AI", "PATH", "S", "OKTA", "IGV",
  ],
  "EV / Auto": ["TSLA", "RIVN", "LCID", "NIO", "XPEV", "LI", "F", "GM", "STLA", "TM"],
  "Crypto-linked": ["COIN", "MSTR", "MARA", "RIOT", "CLSK", "HUT", "IBIT", "BITO", "BMNR", "HOOD", "CRCL", "GBTC", "ETHA"],
  "China ADR": ["BABA", "JD", "PDD", "BIDU", "BEKE", "FXI", "KWEB", "TCEHY"],
  Financials: ["JPM", "BAC", "C", "WFC", "GS", "MS", "SCHW", "XLF", "KRE", "SOFI", "PYPL", "SQ", "XYZ", "AFRM", "V", "MA", "AXP", "BRK"],
  Energy: ["XOM", "CVX", "OXY", "COP", "SLB", "HAL", "XLE", "USO", "YPF", "DVN", "EOG", "UNG"],
  "Health care": ["LLY", "NVO", "UNH", "PFE", "MRNA", "JNJ", "ABBV", "MRK", "XLV", "XBI", "HIMS", "CVS", "AMGN", "BMY"],
  Consumer: ["WMT", "TGT", "COST", "HD", "LOW", "NKE", "SBUX", "MCD", "DIS", "CMG", "LULU", "ROKU", "UBER", "LYFT", "ABNB", "DASH", "BKNG", "XLY"],
  Industrials: ["BA", "CAT", "DE", "GE", "RTX", "LMT", "MMM", "UPS", "FDX", "XLI", "TRMB"],
  "Rates / bonds": ["UST-LONG", "IEF", "SHY", "HYG", "LQD", "AGG"],
  "Index": ["NDX", "SPX", "RUT", "DIA", "VIX", "UVXY", "VXX"],
  "Utilities": ["XLU", "NEE", "DUK", "SO", "VST", "CEG", "NRG", "OKLO", "SMR"],
  Metals: ["GLD", "SLV", "GDX", "NEM", "FCX", "MP"],
};

const SECTOR_BY_ISSUER: Record<string, string> = Object.fromEntries(
  Object.entries(SECTORS).flatMap(([sector, names]) => names.map((name) => [name, sector])),
);

/**
 * Long-duration growth names whose multiples compress when long yields jump.
 * Sep 30 2026: six GOOG/GOOGL calls lost 16–26% while 10Y/30Y rose ahead of reports.
 */
const LONG_DURATION_TECH = new Set<string>([
  ...SECTORS["Mega-cap tech"],
  ...SECTORS.Software,
  "NVDA", "AMD", "AVGO", "SMCI", "ARM", "MRVL", "TSLA", "NDX", "COIN", "MSTR", "HOOD", "ROKU",
  "UBER", "ABNB", "DASH", "RIVN", "ARKK",
]);

export function issuerKey(ticker: string): string {
  const t = (ticker || "").trim().toUpperCase();
  return ISSUER_ALIASES[t] ?? t;
}

export function sectorOf(ticker: string): string {
  const issuer = issuerKey(ticker);
  return SECTOR_BY_ISSUER[issuer] ?? `Other:${issuer}`;
}

export function isLongDurationTech(ticker: string): boolean {
  return LONG_DURATION_TECH.has(issuerKey(ticker));
}

export type ConcentrationCaps = {
  maxPerIssuer: number;
  maxPerSector: number;
};

export const DEFAULT_CAPS: ConcentrationCaps = { maxPerIssuer: 2, maxPerSector: 3 };

export type CapDrop = { option_chain: string; ticker: string; reason: string };

/**
 * Walk an already-sorted list and keep rows until a cap trips.
 * GOOG + GOOGL share one issuer slot; sector cap counts issuers' contracts.
 */
export function applyConcentrationCaps<T extends { alert: { ticker: string; option_chain: string; id: string } }>(
  rows: T[],
  limit: number,
  caps: ConcentrationCaps = DEFAULT_CAPS,
): { kept: T[]; dropped: CapDrop[] } {
  const perIssuer = new Map<string, number>();
  const perSector = new Map<string, number>();
  const seen = new Set<string>();
  const kept: T[] = [];
  const dropped: CapDrop[] = [];
  for (const row of rows) {
    if (kept.length >= limit) break;
    const chain = row.alert.option_chain || row.alert.id;
    if (seen.has(chain)) continue;
    const issuer = issuerKey(row.alert.ticker);
    const sector = sectorOf(row.alert.ticker);
    const nIssuer = perIssuer.get(issuer) ?? 0;
    const nSector = perSector.get(sector) ?? 0;
    if (nIssuer >= caps.maxPerIssuer) {
      dropped.push({ option_chain: chain, ticker: row.alert.ticker, reason: `issuer cap ${caps.maxPerIssuer} (${issuer})` });
      continue;
    }
    if (nSector >= caps.maxPerSector) {
      dropped.push({ option_chain: chain, ticker: row.alert.ticker, reason: `sector cap ${caps.maxPerSector} (${sector})` });
      continue;
    }
    seen.add(chain);
    perIssuer.set(issuer, nIssuer + 1);
    perSector.set(sector, nSector + 1);
    kept.push(row);
  }
  return { kept, dropped };
}
