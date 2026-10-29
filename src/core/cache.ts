import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "../config.js";
import { gunzipSync, gzipSync } from "node:zlib";
import { isRedisCapacityError, markRedisDegraded, redisDegraded } from "./degraded.js";
import { logError } from "./errors.js";

/**
 * Pluggable string cache. Values are opaque strings (usually JSON).
 * - MemoryCache: in-process LRU bounded by approximate byte size.
 * - UpstashCache: Upstash Redis REST (works on Vercel/serverless).
 * - TieredCache: memory L1 in front of Redis L2 (used when Upstash is configured).
 */
export interface Cache {
  readonly kind: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryCache implements Cache {
  readonly kind = "memory";
  private lru: LRUCache<string, string>;
  constructor(maxBytes = 128 * 1024 * 1024) {
    this.lru = new LRUCache<string, string>({
      maxSize: maxBytes,
      sizeCalculation: (v, k) => v.length + k.length || 1,
      ttlAutopurge: false,
    });
  }
  async get(key: string) {
    return this.lru.get(key);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    // Skip values bigger than 1/4 of the cache to avoid thrashing.
    if (value.length > (this.lru.maxSize ?? Infinity) / 4) return;
    this.lru.set(key, value, { ttl: Math.max(1, ttlSeconds) * 1000 });
  }
}

/**
 * Redis key for a cache entry: the logical key (which contains upstream URLs and therefore tool
 * arguments such as searched names) is hashed, so Redis key names never reveal what was asked.
 */
export function redisCacheKey(key: string): string {
  return `${config().cachePrefix}c:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

/**
 * Large values are stored gzip-compressed (base64) in Redis, marked with a control-character prefix
 * that never starts a JSON document or a SEC response body. Uncompressed values stay readable.
 */
export const REDIS_COMPRESS_MIN_BYTES = 8 * 1024;
const GZ_MARK = "\u0001gz1:";
/** Hard cap on a decompressed value (defence against a corrupt or hostile entry). */
const GUNZIP_MAX_BYTES = 32 * 1024 * 1024;

export function encodeForRedis(value: string): string {
  if (value.length < REDIS_COMPRESS_MIN_BYTES) return value;
  const z = GZ_MARK + gzipSync(Buffer.from(value, "utf8"), { level: 9 }).toString("base64");
  return z.length < value.length ? z : value;
}
export function decodeFromRedis(stored: string): string | undefined {
  if (!stored.startsWith(GZ_MARK)) return stored;
  try {
    return gunzipSync(Buffer.from(stored.slice(GZ_MARK.length), "base64"), { maxOutputLength: GUNZIP_MAX_BYTES }).toString("utf8");
  } catch (e) {
    logError("cache-decode", e);
    return undefined; // treat as a miss
  }
}

/**
 * Cache-write guard (the Redis database runs with eviction OFF, so the cache must bound itself):
 *  - a fleet-wide daily byte budget (CACHE_WRITE_BUDGET_BYTES) counted with one INCRBY on
 *    `<prefix>cw:<YYYYMMDD>` pipelined with the SET (EXPIREAT once per instance per day: the key
 *    expires 1 h after its UTC day ends, i.e. a <= 25 h TTL). The last counter value is memoised; once
 *    the known total plus the next value would exceed the budget, writes are skipped locally with
 *    0 commands until UTC midnight. Reads continue.
 *  - a capacity error on a cache write (`ERR DB capacity quota exceeded`, OOM / maxmemory) switches
 *    only cache writes off on this instance for CACHE_FULL_COOLDOWN_MS ("redis full"). Quotas,
 *    API keys and suppression are not affected and keep their own fail-closed handling.
 */
export const CACHE_FULL_COOLDOWN_MS = 10 * 60_000;
const writeState = { day: "", known: 0, exhausted: false, expireSetDay: "", fullUntil: 0, fullSince: 0, skipped: 0 };

function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}
function nextUtcMidnightSeconds(now: number): number {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000);
}
export function cacheBudgetKey(now = Date.now()): string {
  return `${config().cachePrefix}cw:${utcDayOf(now)}`;
}
export function resetCacheWriteState(): void {
  Object.assign(writeState, { day: "", known: 0, exhausted: false, expireSetDay: "", fullUntil: 0, fullSince: 0, skipped: 0 });
}
function rollDay(now: number): string {
  const day = utcDayOf(now);
  if (writeState.day !== day) Object.assign(writeState, { day, known: 0, exhausted: false });
  return day;
}
export function cacheWriteStatus(now = Date.now()): {
  writes: "ok" | "redis full" | "budget exhausted" | "disabled";
  budget_bytes: number;
  known_used_bytes: number;
  since?: string;
  until?: string;
} {
  const budget = config().cacheWriteBudgetBytes;
  rollDay(now);
  const base = { budget_bytes: budget, known_used_bytes: writeState.known };
  if (now < writeState.fullUntil)
    return { writes: "redis full", ...base, since: new Date(writeState.fullSince).toISOString(), until: new Date(writeState.fullUntil).toISOString() };
  if (budget <= 0) return { writes: "disabled", ...base };
  if (writeState.exhausted) return { writes: "budget exhausted", ...base, until: new Date(nextUtcMidnightSeconds(now) * 1000).toISOString() };
  return { writes: "ok", ...base };
}
function markCacheFull(why: unknown, now: number): void {
  if (now >= writeState.fullUntil) {
    writeState.fullSince = now;
    logError("redis-full", why);
  }
  writeState.fullUntil = now + CACHE_FULL_COOLDOWN_MS;
}

export class UpstashCache implements Cache {
  readonly kind = "upstash";
  constructor(
    readonly redis: Redis,
    private maxValueBytes: number,
    private budgetBytes: number = config().cacheWriteBudgetBytes,
  ) {}
  async get(key: string) {
    if (redisDegraded()) return undefined; // save commands / latency while Redis is down or over plan
    try {
      const v = await this.redis.get<string>(redisCacheKey(key));
      return v == null ? undefined : decodeFromRedis(String(v));
    } catch (e) {
      markRedisDegraded(e);
      return undefined; // cache failures must never break tools
    }
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (redisDegraded() || this.budgetBytes <= 0) return;
    const now = Date.now();
    if (now < writeState.fullUntil) return; // "redis full": 0 commands
    const day = rollDay(now);
    if (writeState.exhausted) return; // budget exhausted until UTC midnight: 0 commands
    const stored = encodeForRedis(value);
    const rkey = redisCacheKey(key);
    if (Buffer.byteLength(stored, "utf8") > this.maxValueBytes) return;
    const bytes = Buffer.byteLength(stored, "utf8") + rkey.length;
    if (writeState.known + bytes > this.budgetBytes) {
      writeState.exhausted = true;
      return;
    }
    const bkey = `${config().cachePrefix}cw:${day}`;
    const setExpiry = writeState.expireSetDay !== day;
    try {
      const p = this.redis.pipeline();
      p.incrby(bkey, bytes);
      if (setExpiry) p.expireat(bkey, nextUtcMidnightSeconds(now) + 3600);
      p.set(rkey, stored, { ex: Math.max(1, Math.min(Math.round(ttlSeconds), 24 * 3600)) });
      const res = (await p.exec()) as unknown[];
      if (setExpiry) writeState.expireSetDay = day;
      const total = Number(res[0]);
      if (writeState.day === day && Number.isFinite(total)) {
        writeState.known = Math.max(writeState.known, total);
        if (writeState.known >= this.budgetBytes) writeState.exhausted = true;
      }
    } catch (e) {
      if (isRedisCapacityError(e)) markCacheFull(e, now);
      else markRedisDegraded(e);
    }
  }
}

export class TieredCache implements Cache {
  readonly kind: string;
  constructor(
    private l1: Cache,
    private l2: Cache,
  ) {
    this.kind = `${l1.kind}+${l2.kind}`;
  }
  async get(key: string) {
    const a = await this.l1.get(key);
    if (a !== undefined) return a;
    const b = await this.l2.get(key);
    // L1 copy lives for a short time only; L2 owns the real TTL.
    if (b !== undefined) await this.l1.set(key, b, 300);
    return b;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await Promise.all([this.l1.set(key, value, Math.min(ttlSeconds, 3600)), this.l2.set(key, value, ttlSeconds)]);
  }
}

let instance: Cache | undefined;
let memoryInstance: Cache | undefined;
let redisClient: Redis | undefined;

export function getRedis(): Redis | undefined {
  const c = config();
  if (!c.upstashUrl || !c.upstashToken) return undefined;
  if (!redisClient) redisClient = new Redis({ url: c.upstashUrl, token: c.upstashToken, automaticDeserialization: false });
  return redisClient;
}

/** Process-local cache (never Redis). */
export function getMemoryCache(): Cache {
  if (!memoryInstance) memoryInstance = new MemoryCache(config().memoryCacheMb * 1024 * 1024);
  return memoryInstance;
}

export function getCache(): Cache {
  if (instance) return instance;
  const c = config();
  const mem = getMemoryCache();
  const redis = getRedis();
  instance = redis ? new TieredCache(mem, new UpstashCache(redis, c.redisMaxValueBytes)) : mem;
  return instance;
}

export function setCache(c: Cache | undefined, memory?: Cache): void {
  instance = c;
  memoryInstance = memory ?? (c === undefined ? undefined : memoryInstance);
}

export interface CacheOptions {
  /** "shared" (default) = memory + Redis when configured; "memory" = this process only. */
  tier?: "shared" | "memory";
}

/** Read-through helper for JSON-serialisable values. */
export async function cached<T>(key: string, ttlSeconds: number, produce: () => Promise<T>, opts: CacheOptions = {}): Promise<T> {
  const cache = opts.tier === "memory" ? getMemoryCache() : getCache();
  const full = config().cachePrefix + key;
  const hit = await cache.get(full);
  if (hit !== undefined) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      /* fallthrough */
    }
  }
  const value = await produce();
  if (value === undefined) return value;
  await cache.set(full, JSON.stringify(value), ttlSeconds);
  return value;
}

/** TTLs in seconds. */
export const TTL = {
  tickers: 24 * 3600,
  submissions: 10 * 60,
  submissionsHistory: 6 * 3600,
  companyFacts: 6 * 3600,
  companyConcept: 6 * 3600,
  frames: 12 * 3600,
  filingDoc: 24 * 3600, // raw filed documents (memory tier only)
  filingDocShared: 24 * 3600, // processed/trimmed text and parsed Form 4s in Redis (max Redis TTL is 24 h)
  stateSearch: 3600,
} as const;
