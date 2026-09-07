/** Normalize a pasted Unusual Whales key. Accepts raw token or `Bearer …`. */

export function normalizeUwKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let key = raw.trim();
  key = key.replace(/^["']+|["']+$/g, "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  key = key.replace(/\s+/g, "");
  return key;
}

export function looksLikeUwKey(key: string): boolean {
  if (key.length < 8 || key.length > 4096) return false;
  if (key.includes(" ") || key.includes("\n")) return false;
  return /^[A-Za-z0-9._~+/=-]+$/.test(key);
}
