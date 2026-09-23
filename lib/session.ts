/** US cash-session helpers. America/New_York, 9:30 open. */

const ET = "America/New_York";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function tradingDateET(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function etOffsetForLocalWall(dateStr: string, hour: number, minute: number): "-04:00" | "-05:00" {
  for (const offset of ["-04:00", "-05:00"] as const) {
    const instant = new Date(`${dateStr}T${pad(hour)}:${pad(minute)}:00${offset}`);
    const back = tradingDateET(instant);
    const clock = new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
    const [h, m] = clock.split(":").map(Number);
    if (back === dateStr && h === hour && m === minute) return offset;
  }
  return "-04:00";
}

export function sessionOpenUtc(now = new Date()): Date {
  const date = tradingDateET(now);
  const offset = etOffsetForLocalWall(date, 9, 30);
  return new Date(`${date}T09:30:00${offset}`);
}

export function sessionMorningCutoffUtc(now = new Date()): Date {
  const date = tradingDateET(now);
  const offset = etOffsetForLocalWall(date, 10, 0);
  return new Date(`${date}T10:00:00${offset}`);
}

/**
 * Late-afternoon tape. Sep 2026 backtest: prints after 14:00 ET were ~97% flat
 * and should not lead the actionable card. The live board still shows them.
 */
export const LATE_SESSION_HOUR_ET = 14;

export function sessionLateCutoffUtc(now = new Date()): Date {
  const date = tradingDateET(now);
  const offset = etOffsetForLocalWall(date, LATE_SESSION_HOUR_ET, 0);
  return new Date(`${date}T${pad(LATE_SESSION_HOUR_ET)}:00:00${offset}`);
}

export function isLateSessionPrint(createdAt: string, now = new Date()): boolean {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  if (!isInCurrentSession(createdAt, now)) return false;
  return created.getTime() >= sessionLateCutoffUtc(now).getTime();
}

export function sessionHasOpened(now = new Date()): boolean {
  return now.getTime() >= sessionOpenUtc(now).getTime();
}

function weekdayShort(instant: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short" }).format(instant);
}

/** 9:30 ET open of the previous weekday session (skips Sat/Sun). */
export function previousSessionOpenUtc(now = new Date()): Date {
  const currentOpen = sessionOpenUtc(now);
  let cursor = new Date(currentOpen.getTime() - 36 * 3600_000);
  for (let i = 0; i < 8; i += 1) {
    const open = sessionOpenUtc(cursor);
    const wd = weekdayShort(open);
    if (wd !== "Sat" && wd !== "Sun" && open.getTime() < currentOpen.getTime()) {
      return open;
    }
    cursor = new Date(cursor.getTime() - 24 * 3600_000);
  }
  return new Date(currentOpen.getTime() - 86_400_000);
}

export function hoursSinceCreated(createdAt: string, now = new Date()): number {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return Number.POSITIVE_INFINITY;
  return (now.getTime() - created.getTime()) / 3_600_000;
}

/** Older than one trading session: created_at before the prior weekday 9:30 ET. */
export function isStalePrint(createdAt: string, now = new Date()): boolean {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return true;
  return created.getTime() < previousSessionOpenUtc(now).getTime();
}

export type PrintAgeBand = "fresh" | "session" | "aging" | "aged" | "stale";

/**
 * Sep 4 study: aged call watches faded; fresh ask-sweeps followed through.
 * fresh <2h, session 2–4h, aging 4–8h, aged 8h+ same tape, stale = before prior session 9:30 ET.
 */
export function printAgeBand(createdAt: string, now = new Date()): PrintAgeBand {
  if (isStalePrint(createdAt, now)) return "stale";
  const hours = hoursSinceCreated(createdAt, now);
  if (hours < 2) return "fresh";
  if (hours < 4) return "session";
  if (hours < 8) return "aging";
  return "aged";
}

/** 4–8h old and not yet stale (morning print scored later the same session). */
export function isAgingPrint(createdAt: string, now = new Date()): boolean {
  return printAgeBand(createdAt, now) === "aging";
}

/** 8h+ and not yet stale — too old to treat as a live setup. */
export function isAgedPrint(createdAt: string, now = new Date()): boolean {
  return printAgeBand(createdAt, now) === "aged";
}

export function morningWindowClosed(now = new Date()): boolean {
  return now.getTime() >= sessionMorningCutoffUtc(now).getTime();
}

export function isInCurrentSession(createdAt: string, now = new Date()): boolean {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  return created.getTime() >= sessionOpenUtc(now).getTime();
}

export function isInMorningWindow(createdAt: string, now = new Date()): boolean {
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) return false;
  const open = sessionOpenUtc(now).getTime();
  const cutoff = sessionMorningCutoffUtc(now).getTime();
  const t = created.getTime();
  return t >= open && t <= cutoff;
}

export function isExpiredContract(expiry: string, now = new Date()): boolean {
  const day = expiry.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < tradingDateET(now);
}

/** Unix seconds of today's 9:30 ET open. UW `newer_than` accepts unix or ISO date; RFC3339 datetimes do not filter. */
export function newerThanParam(now = new Date()): string {
  return String(Math.floor(sessionOpenUtc(now).getTime() / 1000));
}

/** Unix seconds of today's 10:00 ET morning cutoff. UW `older_than` exclusive-ish bound. */
export function morningOlderThanParam(now = new Date()): string {
  return String(Math.floor(sessionMorningCutoffUtc(now).getTime() / 1000));
}
