import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { LRUCache } from "lru-cache";
import { config } from "../config.js";
import { getRedis } from "./cache.js";
import { markRedisDegraded, redisDegraded } from "./degraded.js";
import { utcDay, type Principal } from "./quota.js";

/**
 * Self-verifying API keys: `eem_<id>_<mac>` where id is 12 random base62 chars and mac is
 * HMAC-SHA256(API_KEY_SECRET, id) truncated to 24 hex chars. Forged or random keys are rejected
 * locally (no Redis command); only MAC-valid keys are looked up, to check they were not revoked.
 */
export const KEY_RE = /^eem_([A-Za-z0-9]{12})_([0-9a-f]{24})$/;
const ID_RE = /^[A-Za-z0-9]{12}$/;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function keyMac(id: string): string {
  return createHmac("sha256", config().apiKeySecret).update(id).digest("hex").slice(0, 24);
}

function randomId(len = 12): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < len) for (const b of randomBytes(32)) if (b < 248 && out.length < len) out += alphabet[b % 62]; // unbiased
  return out;
}

export function generateApiKey(): { key: string; id: string } {
  const id = randomId();
  return { key: `eem_${id}_${keyMac(id)}`, id };
}

/** Parse and verify the MAC. Returns the key id, or null for anything forged or malformed. */
export function parseApiKey(key: string): string | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const a = Buffer.from(m[2]!, "hex");
  const b = Buffer.from(keyMac(m[1]!), "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? m[1]! : null;
}

/**
 * Stored per key (Redis `<prefix>apikey:<id>`): creation date and optional custom limits only.
 * No owner name, email or other contact is collected; the key request (e.g. a GitHub issue) is the
 * only place that links a holder to a key id, and the operator can delete either independently.
 */
export interface KeyRecord {
  created: string; // YYYY-MM-DD
  per_day?: number;
  per_minute?: number;
}

export const apiKeyRedisKey = (id: string) => `${config().cachePrefix}apikey:${id}`;

export async function storeApiKey(redis: Redis, id: string, rec: KeyRecord): Promise<void> {
  await redis.set(apiKeyRedisKey(id), JSON.stringify(rec));
}

/** Resolve "eem_<id>_<mac>" or a bare id to the id. */
export function keyIdOf(keyOrId: string): string | null {
  if (ID_RE.test(keyOrId)) return keyOrId;
  return KEY_RE.exec(keyOrId)?.[1] ?? null;
}

/**
 * Delete a key: its record and any of its quota counters still alive (today's and yesterday's day
 * counters, minute counters). After this nothing about the key remains in Redis.
 */
export async function deleteApiKey(redis: Redis, keyOrId: string): Promise<{ record: boolean; counters: number }> {
  const id = keyIdOf(keyOrId);
  if (!id) throw new Error("Not an API key or key id.");
  const record = (await redis.del(apiKeyRedisKey(id))) > 0;
  const prefix = config().cachePrefix;
  let counters = 0;
  for (const pattern of [`${prefix}q:d:key:${id}:*`, `${prefix}q:m:key:${id}:*`]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: pattern, count: 500 });
      cursor = String(next);
      if (keys.length) counters += await redis.del(...keys);
    } while (cursor !== "0");
  }
  memo.delete(id);
  return { record, counters };
}
/** @deprecated use deleteApiKey */
export const revokeApiKey = async (redis: Redis, keyOrId: string) => (await deleteApiKey(redis, keyOrId)).record;

const memo = new LRUCache<string, Principal | false>({ max: 10_000, ttl: 5 * 60_000 });

function envKeyMatch(key: string): boolean {
  const h = Buffer.from(sha256(key), "hex");
  return config().apiKeys.some((k) => timingSafeEqual(Buffer.from(sha256(k), "hex"), h));
}

/**
 * Resolve an API key to a principal, or null if invalid.
 * - MCP_API_KEYS (static) keys: accepted as-is, no Redis.
 * - Minted keys: MAC verified locally first; forged/random keys cost nothing. A MAC-valid key is
 *   looked up once (to honour deletion and per-key limits) and memoised (valid 5 min, deleted 1 min).
 * - Redis unavailable: degraded mode accepts MAC-valid keys with default key limits (`unverified`),
 *   because a deleted key could otherwise only be used until Redis recovers.
 */
export async function verifyApiKey(key: string): Promise<Principal | null> {
  if (envKeyMatch(key)) return { id: `key:env${sha256(key).slice(0, 12)}`, tier: "key" };
  const id = parseApiKey(key);
  if (!id) return null;
  const hit = memo.get(id);
  if (hit !== undefined) return hit || null;
  const redis = getRedis();
  if (!redis) return null; // minted keys need the key registry
  if (redisDegraded()) return { id: `key:${id}`, tier: "key", unverified: true };
  let p: Principal | false = false;
  try {
    const raw = await redis.get<string>(apiKeyRedisKey(id));
    if (raw) {
      const rec = (typeof raw === "string" ? JSON.parse(raw) : raw) as KeyRecord;
      p = { id: `key:${id}`, tier: "key", perDay: rec.per_day, perMinute: rec.per_minute };
    }
  } catch (e) {
    markRedisDegraded(e);
    return { id: `key:${id}`, tier: "key", unverified: true };
  }
  memo.set(id, p, { ttl: p ? 5 * 60_000 : 60_000 });
  return p || null;
}

export function clearApiKeyMemo(): void {
  memo.clear();
  failures.clear();
}

/**
 * In-memory limiter for failed key attempts per client (hashed IP), in front of any Redis work:
 * after MAX_KEY_FAILURES bad keys in 10 minutes the client gets 429 without further checks.
 */
export const MAX_KEY_FAILURES = 10;
const failures = new LRUCache<string, number>({ max: 50_000, ttl: 10 * 60_000 });
export function keyFailuresExceeded(clientId: string): boolean {
  return (failures.get(clientId) ?? 0) >= MAX_KEY_FAILURES;
}
export function recordKeyFailure(clientId: string): void {
  failures.set(clientId, (failures.get(clientId) ?? 0) + 1, { noUpdateTTL: failures.has(clientId) });
}

/**
 * Client IP. On Vercel, x-vercel-forwarded-for is set by the platform and cannot be supplied by the
 * client; x-forwarded-for (first hop) and x-real-ip follow. The self-hosted node server overwrites
 * these from the socket unless TRUST_PROXY=1.
 */
export function clientIp(req: Request): string {
  const first = (h: string) => req.headers.get(h)?.split(",")[0]?.trim() || undefined;
  return first("x-vercel-forwarded-for") ?? first("x-forwarded-for") ?? first("x-real-ip") ?? "unknown";
}

const saltMemo = new Map<string, string>();
/**
 * Salt for one UTC day: HMAC-SHA256(IP_HASH_SALT, "YYYYMMDD"). Hashes from different days cannot
 * be linked, and nothing that would allow re-identification survives the day it was created on.
 */
export function daySalt(day: string): string {
  let s = saltMemo.get(day);
  if (!s) {
    s = createHmac("sha256", config().ipHashSecret).update(day).digest("hex");
    if (saltMemo.size > 4) saltMemo.clear();
    saltMemo.set(day, s);
  }
  return s;
}
export function clearSaltMemo(): void {
  saltMemo.clear();
}

/**
 * Hash an IP (IPv6 grouped by /64) with the salt of the current UTC day, so raw addresses never
 * reach Redis or logs and hashes rotate daily. `network` is the hashed enclosing IPv4 /24 or
 * IPv6 /48, used for a coarser daily cap against address rotation. `day` is fixed here, once per
 * request, and the quota store uses the same day for its counter keys, so a request that straddles
 * UTC midnight is hashed and counted consistently against one day.
 */
export function ipPrincipal(ip: string, day: string = utcDay()): Principal {
  let norm = ip.toLowerCase();
  let net: string;
  if (norm.includes(":") && !/^::ffff:\d/.test(norm)) {
    const full = expandIpv6(norm);
    net = full ? full.slice(0, 3).join(":") + "::/48" : norm;
    norm = full ? full.slice(0, 4).join(":") + "::/64" : norm;
  } else {
    norm = norm.replace(/^::ffff:/, "");
    const o = norm.split(".");
    net = o.length === 4 ? `${o[0]}.${o[1]}.${o[2]}.0/24` : norm;
  }
  const salt = daySalt(day);
  const h = (v: string) => createHmac("sha256", salt).update(v).digest("hex").slice(0, 20);
  return { id: `ip:${h(norm)}`, tier: "anon", network: `net:${h(net)}`, day };
}

function expandIpv6(ip: string): string[] | undefined {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && h.length !== 8) return undefined;
  const fill = Array(8 - h.length - t.length).fill("0");
  const all = [...h, ...fill, ...t].map((x) => x.padStart(4, "0"));
  return all.length === 8 ? all : undefined;
}
