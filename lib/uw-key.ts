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
  // UUID, JWT, and hex tokens are all valid UW shapes. Do not regex-reject
  // hyphens — iPhone Safari was blocking those with a native pattern check.
  return key.length >= 8 && key.length <= 4096;
}
