import { toNumber } from "@/lib/numbers";

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const fullCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const priceFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPremium(value: string | number): string {
  const n = toNumber(value);
  if (Math.abs(n) >= 10_000) return compactCurrency.format(n);
  return fullCurrency.format(n);
}

export function formatFullPremium(value: string | number): string {
  return fullCurrency.format(toNumber(value));
}

export function formatCompact(value: string | number): string {
  return compactNumber.format(toNumber(value));
}

export function formatPrice(value: string | number): string {
  return priceFmt.format(toNumber(value));
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatSignedPct(value: number): string {
  const pct = value * 100;
  const digits = Math.abs(pct) >= 10 ? 0 : 1;
  const formatted = pct.toFixed(digits);
  if (pct > 0) return `+${formatted}%`;
  return `${formatted}%`;
}

export function formatStrike(value: string | number): string {
  const n = toNumber(value);
  if (Number.isInteger(n)) return n.toFixed(0);
  return n.toFixed(2);
}

export function formatDte(dte: number): string {
  if (dte === 0) return "0DTE";
  return `${dte}d`;
}

export function formatExpiry(expiry: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (!match) return expiry;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}`;
}

export function formatRelativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const deltaSec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (deltaSec < 15) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const mins = Math.round(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
}
