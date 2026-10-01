import "server-only";

import { put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Tiny key/value persistence for FlowGuard state, built to stay inside free tiers.
 *
 * Backends (first that is configured wins):
 *  1. "redis"  – Upstash Redis REST (KV_REST_API_URL/TOKEN, STORAGE_KV_REST_API_URL/TOKEN, UPSTASH_REDIS_REST_URL/TOKEN or any *_KV_REST_API_URL pair, set by the
 *                Vercel Marketplace Upstash integration). Durable, global. All hot state lives here.
 *  2. "local"  – SHADOW_LOCAL_DIR (local tests).
 *  3. "blob"   – Vercel Blob "lite": NO list()/head() ever. Reads fetch the blob by its known URL (a simple op),
 *                at most every BLOB_READ_GAP_MS per key per instance. Only tier "rare" values are written
 *                (logged picks, watches, study snapshots), write-on-change, with a hard per-instance daily
 *                write cap (BLOB_WRITES_PER_DAY, default 25). Hot state stays in memory.
 *  4. "memory" – per instance only.
 *
 * Every read is served from an in-memory copy first (maxAgeMs). Writes are skipped when the JSON is unchanged.
 * Values > 32 KB are gzip+base64 encoded in Redis (bandwidth: free tier is 10 GB/month).
 */

export type KvTier = "hot" | "rare";
export type KvBackend = "redis" | "local" | "blob" | "memory";

type MemEntry = { at: number; value: unknown; json: string | null; persistedJson: string | null; lastWriteAt: number; lastReadAt: number };

const mem = new Map<string, MemEntry>();
const DEFAULT_MAX_AGE_MS = 15_000;
const BLOB_READ_GAP_MS = 5 * 60_000;
const GZIP_OVER = 32 * 1024;

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Upstash REST creds: explicit names first, then any custom-prefixed Marketplace pair (e.g. STORAGE_KV_REST_API_URL). */
function redisConf(): { url: string; token: string } | null {
  const pairs: Array<[string, string]> = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["STORAGE_KV_REST_API_URL", "STORAGE_KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ];
  for (const k of Object.keys(process.env).sort()) {
    const m = /^(.+_)KV_REST_API_URL$/.exec(k);
    if (m) pairs.push([k, `${m[1]}KV_REST_API_TOKEN`]);
    const u = /^(.+_)REDIS_REST_URL$/.exec(k);
    if (u) pairs.push([k, `${u[1]}REDIS_REST_TOKEN`]);
  }
  for (const [uk, tk] of pairs) {
    const url = env(uk);
    const token = env(tk);
    if (url && token && /^https:\/\//.test(url)) return { url: url.replace(/\/$/, ""), token };
  }
  return null;
}

/** Name (never value) of the env var pair in use, for diag. */
export function kvCredSource(): string | null {
  const c = redisConf();
  if (!c) return null;
  for (const k of Object.keys(process.env)) if (env(k).replace(/\/$/, "") === c.url && /REST/.test(k)) return k;
  return "unknown";
}

function blobToken(): string {
  return env("BLOB_READ_WRITE_TOKEN");
}

export function kvBackend(): KvBackend {
  if (redisConf()) return "redis";
  if (env("SHADOW_LOCAL_DIR")) return "local";
  if (blobToken()) return "blob";
  return "memory";
}

// ---------------------------------------------------------------------------
// Daily op accounting + guards (per instance; Redis also keeps a global sampled counter).
// ---------------------------------------------------------------------------
type OpDay = { day: string; redisCmds: number; redisErrors: number; blobReads: number; blobWrites: number; blobSkipped: number; reported: number; redisCapWarned?: boolean };
let ops: OpDay = { day: "", redisCmds: 0, redisErrors: 0, blobReads: 0, blobWrites: 0, blobSkipped: 0, reported: 0 };
let redisFailUntil = 0;
let lastRedisError = "";
let blobDownUntil = 0;
let lastBlobError = "";

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function opDay(): OpDay {
  const d = utcDay();
  if (ops.day !== d) ops = { day: d, redisCmds: 0, redisErrors: 0, blobReads: 0, blobWrites: 0, blobSkipped: 0, reported: 0 };
  return ops;
}

function capNum(name: string, dflt: number): number {
  const raw = env(name);
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : dflt;
}
const blobWriteCap = () => capNum("BLOB_WRITES_PER_DAY", 25);
const blobReadCap = () => capNum("BLOB_READS_PER_DAY", 300);
const redisCmdCap = () => capNum("REDIS_CMDS_PER_INSTANCE_DAY", 8000);

/** True when state survives across instances/cold starts (Redis healthy, or local dir). */
export function kvDurable(): boolean {
  const b = kvBackend();
  if (b === "local") return true;
  if (b !== "redis") return false;
  return Date.now() >= redisFailUntil && opDay().redisCmds < redisCmdCap();
}

export function kvStats() {
  const o = opDay();
  return {
    backend: kvBackend(),
    credEnv: kvCredSource(),
    durable: kvDurable(),
    instanceOpsToday: { ...o, reported: undefined },
    caps: { blobWritesPerDay: blobWriteCap(), blobReadsPerDay: blobReadCap(), redisCmdsPerInstanceDay: redisCmdCap() },
    redisError: Date.now() < redisFailUntil ? lastRedisError : null,
    blobError: lastBlobError || null,
    blobDown: Date.now() < blobDownUntil,
  };
}

// ---------------------------------------------------------------------------
// Redis REST
// ---------------------------------------------------------------------------
async function redis(commands: (string | number)[][]): Promise<unknown[] | null> {
  const conf = redisConf();
  if (!conf || Date.now() < redisFailUntil) return null;
  const o = opDay();
  if (o.redisCmds + commands.length > redisCmdCap()) {
    if (!o.redisCapWarned) {
      o.redisCapWarned = true;
      console.warn(`[kv] Redis per-instance daily command cap reached (${redisCmdCap()}); memory only until UTC midnight.`);
    }
    return null;
  }
  o.redisCmds += commands.length;
  // Sampled global counter (one extra command per 100).
  const sample = Math.floor(o.redisCmds / 100) > o.reported;
  const batch = sample ? [...commands, ["INCRBY", `flowguard/ops/redis-${o.day}`, 100], ["EXPIRE", `flowguard/ops/redis-${o.day}`, 3 * 86400]] : commands;
  if (sample) o.reported = Math.floor(o.redisCmds / 100);
  try {
    const res = await fetch(`${conf.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${conf.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const err = out.find((r) => r.error);
    if (err) throw new Error(String(err.error).slice(0, 160));
    return out.slice(0, commands.length).map((r) => r.result);
  } catch (e) {
    o.redisErrors += 1;
    lastRedisError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    redisFailUntil = Date.now() + 30_000;
    console.error(`[kv] redis error: ${lastRedisError}`);
    return null;
  }
}

function encode(json: string): string {
  if (json.length <= GZIP_OVER) return json;
  return `gz:${gzipSync(json).toString("base64")}`;
}

function decode(raw: string): unknown {
  const text = raw.startsWith("gz:") ? gunzipSync(Buffer.from(raw.slice(3), "base64")).toString("utf8") : raw;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Blob lite (no list/head; known-URL reads)
// ---------------------------------------------------------------------------
function blobUrl(key: string): string | null {
  const token = blobToken();
  const storeId = token.split("_")[3] ?? "";
  return storeId ? `https://${storeId}.private.blob.vercel-storage.com/${key}` : null;
}

function noteBlobError(e: unknown) {
  lastBlobError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  // Suspended / over quota: stop touching Blob for 6 h on this instance (failed calls can still count).
  if (/suspend|quota|limit|forbidden|403/i.test(lastBlobError)) blobDownUntil = Date.now() + 6 * 3600_000;
  console.error(`[kv] blob error: ${lastBlobError}`);
}

async function blobRead(key: string): Promise<{ found: boolean; value: unknown } | null> {
  const url = blobUrl(key);
  if (!url || Date.now() < blobDownUntil) return null;
  const o = opDay();
  if (o.blobReads >= blobReadCap()) return null;
  o.blobReads += 1;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${blobToken()}` }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return { found: false, value: null };
    if (!res.ok) throw new Error(`blob GET HTTP ${res.status}`);
    return { found: true, value: await res.json() };
  } catch (e) {
    noteBlobError(e);
    return null;
  }
}

async function blobWrite(key: string, json: string): Promise<boolean> {
  if (!blobToken() || Date.now() < blobDownUntil) return false;
  const o = opDay();
  if (o.blobWrites >= blobWriteCap()) {
    o.blobSkipped += 1;
    if (o.blobSkipped === 1) console.warn(`[kv] Blob daily write cap reached (${blobWriteCap()}); skipping writes until UTC midnight.`);
    return false;
  }
  o.blobWrites += 1;
  try {
    await put(key, json, { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
    return true;
  } catch (e) {
    noteBlobError(e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function localFile(key: string): string {
  return path.join(env("SHADOW_LOCAL_DIR"), key.replace(/[\\/]/g, "__"));
}

/**
 * Read a JSON value. Served from memory when younger than maxAgeMs (default 15 s).
 * `blobFallback` (Redis mode): on a Redis miss, try the legacy Blob object once per instance and copy it in.
 */
export async function kvGet<T>(key: string, opts: { maxAgeMs?: number; fresh?: boolean; blobFallback?: boolean } = {}): Promise<T | null> {
  const now = Date.now();
  const hit = mem.get(key);
  const maxAge = opts.fresh ? 0 : (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  if (hit && now - hit.lastReadAt < maxAge) return (hit.value as T) ?? null;
  const backend = kvBackend();
  const keep = (value: unknown, json: string | null) => {
    mem.set(key, { at: now, value, json, persistedJson: json, lastWriteAt: hit?.lastWriteAt ?? 0, lastReadAt: now });
    return (value as T) ?? null;
  };
  if (backend === "redis") {
    const out = await redis([["GET", key]]);
    if (!out) {
      if (hit) hit.lastReadAt = now; // back off; serve memory
      return (hit?.value as T) ?? null;
    }
    const raw = out[0];
    if (typeof raw === "string") {
      try {
        const value = decode(raw);
        return keep(value, JSON.stringify(value));
      } catch {
        return (hit?.value as T) ?? null;
      }
    }
    if (hit && hit.persistedJson === null && hit.json !== null) {
      // Written locally but not yet persisted (Redis was down): keep it.
      hit.lastReadAt = now;
      return hit.value as T;
    }
    if (opts.blobFallback && blobToken() && !hit) {
      const legacy = await blobRead(key);
      if (legacy?.found) {
        await kvSet(key, legacy.value, { tier: "rare" });
        return (legacy.value as T) ?? null;
      }
    }
    return keep(hit?.value ?? null, hit?.json ?? null);
  }
  if (backend === "local") {
    try {
      const value = JSON.parse(await fs.readFile(localFile(key), "utf8"));
      return keep(value, JSON.stringify(value));
    } catch {
      return (hit?.value as T) ?? null;
    }
  }
  if (backend === "blob") {
    // Known-URL read at most every BLOB_READ_GAP_MS per key per instance; never list/head.
    if (hit && now - hit.lastReadAt < Math.max(maxAge, BLOB_READ_GAP_MS)) return (hit.value as T) ?? null;
    const r = await blobRead(key);
    if (!r) {
      if (hit) hit.lastReadAt = now;
      else mem.set(key, { at: now, value: null, json: null, persistedJson: null, lastWriteAt: 0, lastReadAt: now });
      return (hit?.value as T) ?? null;
    }
    if (!r.found) return keep(hit?.value ?? null, hit?.json ?? null);
    // Prefer a newer local write that has not reached Blob.
    if (hit && hit.json !== hit.persistedJson && hit.at > now - BLOB_READ_GAP_MS) {
      hit.lastReadAt = now;
      return hit.value as T;
    }
    return keep(r.value, JSON.stringify(r.value));
  }
  return (hit?.value as T) ?? null;
}

/**
 * Write a JSON value. Memory is updated immediately; the backend only when the JSON changed and
 * (optionally) at most every minGapMs. Blob mode persists tier "rare" only. Returns true when persisted.
 */
export async function kvSet(key: string, value: unknown, opts: { tier?: KvTier; ttlSec?: number; minGapMs?: number } = {}): Promise<boolean> {
  const now = Date.now();
  const json = JSON.stringify(value);
  const prev = mem.get(key);
  const entry: MemEntry = {
    at: now,
    value,
    json,
    persistedJson: prev?.persistedJson ?? null,
    lastWriteAt: prev?.lastWriteAt ?? 0,
    lastReadAt: now,
  };
  mem.set(key, entry);
  if (entry.persistedJson === json) return true; // unchanged
  if (opts.minGapMs && now - entry.lastWriteAt < opts.minGapMs) return false; // throttled; memory holds it
  const backend = kvBackend();
  let ok = false;
  if (backend === "redis") {
    const cmd: (string | number)[] = ["SET", key, encode(json)];
    if (opts.ttlSec) cmd.push("EX", Math.round(opts.ttlSec));
    ok = (await redis([cmd])) != null;
  } else if (backend === "local") {
    try {
      await fs.mkdir(env("SHADOW_LOCAL_DIR"), { recursive: true });
      await fs.writeFile(localFile(key), json);
      ok = true;
    } catch {
      ok = false;
    }
  } else if (backend === "blob") {
    if ((opts.tier ?? "hot") === "rare") ok = await blobWrite(key, json);
  }
  if (ok) {
    entry.persistedJson = json;
    entry.lastWriteAt = now;
  }
  return ok;
}

/** Atomic float counter (Redis); memory elsewhere. Returns the new total. */
export async function kvIncrFloat(key: string, by: number, ttlSec: number): Promise<number> {
  if (kvBackend() === "redis") {
    const out = await redis([["INCRBYFLOAT", key, by], ["EXPIRE", key, ttlSec]]);
    if (out) {
      const v = Number(out[0]);
      mem.set(key, { at: Date.now(), value: v, json: String(v), persistedJson: String(v), lastWriteAt: Date.now(), lastReadAt: Date.now() });
      return v;
    }
  }
  const cur = Number(mem.get(key)?.value ?? 0) + by;
  mem.set(key, { at: Date.now(), value: cur, json: String(cur), persistedJson: null, lastWriteAt: 0, lastReadAt: Date.now() });
  if (kvBackend() === "local") await kvSet(key, cur);
  return cur;
}

export async function kvGetNumber(key: string, maxAgeMs = 10_000): Promise<number> {
  const v = await kvGet<number | string>(key, { maxAgeMs });
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** SET NX EX lock (Redis). Without Redis there is no cross-instance lock: returns true. */
export async function kvSetNx(key: string, value: string, ttlSec: number): Promise<boolean> {
  if (kvBackend() !== "redis") return true;
  const out = await redis([["SET", key, value, "NX", "EX", Math.max(1, Math.round(ttlSec))]]);
  if (!out) return true; // Redis down: do not block work (each instance falls back to memory)
  return out[0] === "OK";
}

export async function kvDel(key: string): Promise<void> {
  mem.delete(key);
  if (kvBackend() === "redis") await redis([["DEL", key]]);
}

/** Admin diagnostic: set+get round trip on the active backend (no secrets). */
export async function kvHealth() {
  const t0 = Date.now();
  const key = "flowguard/health-check";
  const stamp = new Date().toISOString();
  mem.delete(key);
  const wrote = await kvSet(key, { stamp }, { tier: "hot", ttlSec: 3600 });
  mem.delete(key);
  const back = kvBackend() === "blob" ? null : await kvGet<{ stamp?: string }>(key, { fresh: true });
  let globalRedisOpsToday: number | null = null;
  if (kvBackend() === "redis") {
    const out = await redis([["GET", `flowguard/ops/redis-${utcDay()}`]]);
    globalRedisOpsToday = out ? Number(out[0] ?? 0) : null;
  }
  return {
    ...kvStats(),
    roundTrip: kvBackend() === "blob" ? "skipped (blob lite never writes hot keys)" : wrote && back?.stamp === stamp ? "ok" : "failed",
    globalRedisOpsToday,
    ms: Date.now() - t0,
  };
}

/** Admin diagnostic for the legacy Blob store: one known-URL GET (simple op) + optional one put. */
export async function blobProbe(opts: { write?: boolean } = {}) {
  const key = "flowguard/shadow/puts-book.json";
  const savedDown = blobDownUntil;
  blobDownUntil = 0;
  const read = await blobRead(key);
  let write: string = "skipped";
  if (opts.write) write = (await blobWrite("flowguard/health-probe.json", JSON.stringify({ at: new Date().toISOString() }))) ? "ok" : `error: ${lastBlobError}`;
  if (!read && !blobDownUntil) blobDownUntil = savedDown;
  return { read: read ? (read.found ? "ok (found)" : "ok (404)") : `error: ${lastBlobError}`, write };
}
