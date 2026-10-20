import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { LRUCache } from "lru-cache";
import { config } from "../config.js";
import { getRedis } from "./cache.js";
import { logError } from "./errors.js";
import { utcDay, type Principal } from "./quota.js";

/** Free API keys look like `eem_` + 32 base62 chars. Only their SHA-256 is stored. */
export const KEY_RE = /^eem_[A-Za-z0-9]{32}$/;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function generateApiKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(64);
  let out = "";
  for (const b of bytes) {
    if (b < 248) out += alphabet[b % 62]; // rejection sampling keeps the distribution uniform
    if (out.length === 32) break;
  }
  if (out.length < 32) return generateApiKey();
  return `eem_${out}`;
}

export interface KeyRecord {
  name: string;
  created: string;
  per_day?: number;
  per_minute?: number;
  disabled?: boolean;
}

export const apiKeyRedisKey = (hash: string) => `${config().cachePrefix}apikey:${hash}`;

export async function storeApiKey(redis: Redis, key: string, rec: KeyRecord): Promise<string> {
  const hash = sha256(key);
  await redis.set(apiKeyRedisKey(hash), JSON.stringify(rec));
  return hash;
}

export async function revokeApiKey(redis: Redis, keyOrHash: string): Promise<boolean> {
  const hash = KEY_RE.test(keyOrHash) ? sha256(keyOrHash) : keyOrHash;
  return (await redis.del(apiKeyRedisKey(hash))) > 0;
}

const memo = new LRUCache<string, Principal | false>({ max: 10_000, ttl: 5 * 60_000 });

function envKeyMatch(key: string): boolean {
  const h = Buffer.from(sha256(key), "hex");
  return config().apiKeys.some((k) => timingSafeEqual(Buffer.from(sha256(k), "hex"), h));
}

/**
 * Resolve an API key to a principal, or null if invalid. Keys from MCP_API_KEYS are accepted as-is;
 * others must be well-formed and present in Redis. Results are memoised per instance
 * (valid: 5 min, invalid: 1 min) so repeated requests cost no Redis commands.
 */
export async function verifyApiKey(key: string): Promise<Principal | null> {
  const hash = sha256(key);
  const hit = memo.get(hash);
  if (hit !== undefined) return hit || null;
  let p: Principal | false = false;
  if (envKeyMatch(key)) p = { id: `key:${hash.slice(0, 16)}`, tier: "key" };
  else if (KEY_RE.test(key)) {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get<string>(apiKeyRedisKey(hash));
        if (raw) {
          const rec = (typeof raw === "string" ? JSON.parse(raw) : raw) as KeyRecord;
          if (!rec.disabled) p = { id: `key:${hash.slice(0, 16)}`, tier: "key", perDay: rec.per_day, perMinute: rec.per_minute };
        }
      } catch (e) {
        logError("api-key-lookup", e);
        throw e; // let the caller fail closed rather than silently downgrading
      }
    }
  }
  memo.set(hash, p, { ttl: p ? 5 * 60_000 : 60_000 });
  return p || null;
}

export function clearApiKeyMemo(): void {
  memo.clear();
}

/** Best-effort client IP. On Vercel, x-real-ip / x-forwarded-for are set by the platform. */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "unknown";
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
