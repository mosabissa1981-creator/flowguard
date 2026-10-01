import type { EconEvent } from "@/lib/types";

/**
 * Researched macro seed (desk note study/macro-week-2026-10-01.md, compiled Sep 30 2026).
 * Times converted CT → ET. Merged with the live calendar; live rows win on duplicates.
 * Extend by appending days — the regime reads it by ET date.
 */

export type DayRating = "good" | "careful" | "careful-afternoon" | "sit-out";

export type SeedDay = {
  date: string;
  rating: DayRating;
  note: string;
  events: EconEvent[];
};

const ev = (date: string, timeEt: string, title: string, impact: EconEvent["impact"], forecast = "", previous = ""): EconEvent => ({
  title,
  country: "USD",
  date: `${date}T${timeEt}:00-04:00`,
  impact,
  forecast,
  previous,
});

export const MACRO_SEED: SeedDay[] = [
  {
    date: "2026-10-01",
    rating: "careful",
    note: "Claims 8:30 ET, ISM Manufacturing 10:00 ET (watch prices paid). Trade after ISM. NKE after close.",
    events: [
      ev("2026-10-01", "08:30", "Initial Jobless Claims", "Medium", "200K", "197K"),
      ev("2026-10-01", "10:00", "ISM Manufacturing PMI", "High", "54.9", "54.6"),
      ev("2026-10-01", "10:00", "Construction Spending m/m", "Low", "0.1%", "-0.5%"),
    ],
  },
  {
    date: "2026-10-02",
    rating: "sit-out",
    note: "NFP 8:30 ET — the week's biggest event and the last payrolls before the Oct 27–28 FOMC. Trade only after ~10:00–10:30 ET.",
    events: [
      ev("2026-10-02", "08:30", "Non-Farm Employment Change", "High", "84K", "162K"),
      ev("2026-10-02", "08:30", "Unemployment Rate", "High", "4.1%", "4.1%"),
      ev("2026-10-02", "08:30", "Average Hourly Earnings m/m", "High", "0.3%", "0.3%"),
      ev("2026-10-02", "10:00", "Factory Orders m/m", "Low", "0.2%", "0.9%"),
    ],
  },
  {
    date: "2026-10-05",
    rating: "careful",
    note: "ISM Services + prices paid 10:00 ET (prior prices 72.6). Careful until the release, then good.",
    events: [ev("2026-10-05", "10:00", "ISM Services PMI", "High", "55.0", "55.4")],
  },
  {
    date: "2026-10-06",
    rating: "good",
    note: "Light data. 3Y auction 13:00 ET is low impact. STZ after close.",
    events: [ev("2026-10-06", "13:00", "3-Year Note Auction", "Low")],
  },
  {
    date: "2026-10-07",
    rating: "careful-afternoon",
    note: "10Y auction 13:00 ET + FOMC minutes 14:00 ET — double rate event in the afternoon. Mornings fine.",
    events: [
      ev("2026-10-07", "13:00", "10-Year Note Auction", "High"),
      ev("2026-10-07", "14:00", "FOMC Meeting Minutes", "High"),
    ],
  },
  {
    date: "2026-10-08",
    rating: "careful",
    note: "30Y auction 13:00 ET — the key long-end supply test for US30Y/TLT. Claims 8:30 ET.",
    events: [
      ev("2026-10-08", "08:30", "Initial Jobless Claims", "Medium"),
      ev("2026-10-08", "13:00", "30-Year Bond Auction", "High"),
    ],
  },
  {
    date: "2026-10-09",
    rating: "good",
    note: "UMich sentiment + inflation expectations 10:00 ET (prior 1-yr 4.6%). DAL pre-market. Bonds closed Mon Oct 12 ahead of CPI.",
    events: [ev("2026-10-09", "10:00", "Prelim UoM Consumer Sentiment", "Medium")],
  },
  {
    date: "2026-10-14",
    rating: "sit-out",
    note: "CPI 8:30 ET. Beige Book.",
    events: [ev("2026-10-14", "08:30", "CPI m/m", "High"), ev("2026-10-14", "08:30", "Core CPI m/m", "High")],
  },
  {
    date: "2026-10-15",
    rating: "careful",
    note: "PPI 8:30 ET.",
    events: [ev("2026-10-15", "08:30", "PPI m/m", "High")],
  },
  {
    date: "2026-10-28",
    rating: "careful-afternoon",
    note: "FOMC statement 14:00 ET, press conference 14:30 ET.",
    events: [ev("2026-10-28", "14:00", "FOMC Statement", "High"), ev("2026-10-28", "14:00", "Federal Funds Rate", "High")],
  },
];

export function seedDay(date: string): SeedDay | null {
  return MACRO_SEED.find((d) => d.date === date) ?? null;
}

export function seedEvents(): EconEvent[] {
  return MACRO_SEED.flatMap((d) => d.events);
}
