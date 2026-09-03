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

export function sessionHasOpened(now = new Date()): boolean {
  return now.getTime() >= sessionOpenUtc(now).getTime();
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
