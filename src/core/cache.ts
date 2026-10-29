import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { config } from "../config.js";
import { gunzipSync, gzipSync } from "node:zlib";
import { isRedisCapacityError, markRedisDegraded, redisDegraded } from "./degraded.js";
import { logError } from "./errors.js";
import { currentContext } from "./context.js";

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

/** Values longer than this multiple of the max stored size are not even compressed (they would not fit). */
export const REDIS_COMPRESS_MAX_RATIO = 20;
export function encodeForRedis(value: string): string {
  if (value.length < REDIS_COMPRESS_MIN_BYTES) return value;
  const z = GZ_MARK + gzipSync(Buffer.from(value, "utf8"), { level: 6 }).toString("base64");
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
 *  - a fleet-wide daily byte budget (CACHE_WRITE_BUDGET_BYTES) on `<prefix>cw:<YYYYMMDD>`, enforced
 *    by ONE atomic Lua script per write (CACHE_WRITE_SCRIPT, EVALSHA with an EVAL fallback): if
 *    counter + bytes > budget it returns -1 and writes nothing; otherwise it creates the counter with
 *    `SET 0 NX EXAT <next UTC midnight + 1 h>` (only when missing), INCRBY's it and `SET ... EX`s the
 *    value. The counter therefore never exceeds the budget, whatever the number of instances or
 *    concurrent writes. Each write counts its stored size plus REDIS_ENTRY_OVERHEAD_BYTES.
 *  - local memo (0 commands when it already says no): the first write of the day on an instance
 *    first reads the counter (one GET, shared by concurrent writes), so a cold instance facing a
 *    full counter refuses locally without sending any value. Pending writes are reserved locally
 *    (`known` includes them; `pending` tracks this instance's in-flight bytes) and replies raise the
 *    memo to max(known, fleet total + pending). Once the memo or the script says no, writes are
 *    skipped with 0 commands until the UTC day ends. Reads continue.
 *  - every Redis TTL is capped at min(normal TTL, 24 h, next UTC midnight + 1 h - now), so entries
 *    written on one UTC day are gone 1 h after it ends: resident cache data stays about one day's
 *    budget (at most 2x, only if the next day's budget is spent within its first hour).
 *  - a capacity error on a cache write (`ERR DB capacity quota exceeded`, OOM / maxmemory) switches
 *    only cache writes off on this instance for CACHE_FULL_COOLDOWN_MS ("redis full"). Quotas,
 *    API keys and suppression are not affected and keep their own fail-closed handling.
 */
export const CACHE_FULL_COOLDOWN_MS = 10 * 60_000;
/** Approximate per-key memory overhead (key metadata, expiry entry) counted on top of key + value. */
export const REDIS_ENTRY_OVERHEAD_BYTES = 96;

/**
 * KEYS = [counter, value key]. ARGV = [bytes, budget, counter EXAT, value EX, value].
 * Returns {-1, counter} when the write does not fit (nothing written), else {1, counter after INCRBY}.
 */
export const CACHE_WRITE_SCRIPT = `
local b = tonumber(ARGV[1])
local raw = redis.call('GET', KEYS[1])
local cur = tonumber(raw) or 0
if cur + b > tonumber(ARGV[2]) then return {-1, cur} end
if not raw then redis.call('SET', KEYS[1], '0', 'NX', 'EXAT', ARGV[3]) end
local t = redis.call('INCRBY', KEYS[1], b)
redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[4])
return {1, t}
`;
export const CACHE_WRITE_SCRIPT_SHA = createHash("sha1").update(CACHE_WRITE_SCRIPT).digest("hex");

/** Per-process write memo. Exported for tests that simulate several instances in one process. */
export interface CacheWriteState {
  day: string;
  known: number;
  pending: number;
  exhausted: boolean;
  syncedDay: string;
  sync?: { day: string; p: Promise<boolean> };
  fullUntil: number;
  fullSince: number;
}
export function newCacheWriteState(): CacheWriteState {
  return { day: "", known: 0, pending: 0, exhausted: false, syncedDay: "", sync: undefined, fullUntil: 0, fullSince: 0 };
}
const writeState: CacheWriteState = newCacheWriteState();

function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}
function nextUtcMidnightSeconds(now: number): number {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000);
}
/**
 * Redis TTL actually used: min(ttl, 24 h, seconds until next UTC midnight + 1 h), at least 1 s.
 * A non-finite TTL is never passed to Redis: +Infinity means "as long as allowed", NaN / -Infinity 1 s.
 */
export function redisTtlSeconds(ttlSeconds: number, now = Date.now()): number {
  const toCutoff = nextUtcMidnightSeconds(now) + 3600 - Math.floor(now / 1000);
  const ttl = Number.isFinite(ttlSeconds) ? Math.round(ttlSeconds) : ttlSeconds === Infinity ? 24 * 3600 : 1;
  const out = Math.max(1, Math.min(ttl, 24 * 3600, toCutoff));
  return Number.isFinite(out) ? out : 1;
}
export function cacheBudgetKey(now = Date.now()): string {
  return `${config().cachePrefix}cw:${utcDayOf(now)}`;
}
export function resetCacheWriteState(st: CacheWriteState = writeState): void {
  Object.assign(st, newCacheWriteState());
}
function rollDay(st: CacheWriteState, now: number): string {
  const day = utcDayOf(now);
  // `pending` is kept: in-flight writes settle against the day they were sent on (checked below).
  if (st.day !== day) Object.assign(st, { day, known: 0, exhausted: false });
  return day;
}
export function cacheWriteStatus(now = Date.now(), st: CacheWriteState = writeState): {
  writes: "ok" | "redis full" | "budget exhausted" | "disabled";
  budget_bytes: number;
  known_used_bytes: number;
  since?: string;
  until?: string;
} {
  const budget = config().cacheWriteBudgetBytes;
  rollDay(st, now);
  const base = { budget_bytes: budget, known_used_bytes: st.known };
  if (now < st.fullUntil)
    return { writes: "redis full", ...base, since: new Date(st.fullSince).toISOString(), until: new Date(st.fullUntil).toISOString() };
  if (budget <= 0) return { writes: "disabled", ...base };
  if (st.exhausted) return { writes: "budget exhausted", ...base, until: new Date(nextUtcMidnightSeconds(now) * 1000).toISOString() };
  return { writes: "ok", ...base };
}
function markCacheFull(st: CacheWriteState, why: unknown, now: number): void {
  if (now >= st.fullUntil) {
    st.fullSince = now;
    logError("redis-full", why);
  }
  st.fullUntil = now + CACHE_FULL_COOLDOWN_MS;
}
function onWriteError(st: CacheWriteState, e: unknown, now: number): void {
  if (isRedisCapacityError(e)) markCacheFull(st, e, now);
  else markRedisDegraded(e);
}

export class UpstashCache implements Cache {
  readonly kind = "upstash";
  constructor(
    readonly redis: Redis,
    private maxValueBytes: number,
    private budgetBytes: number = config().cacheWriteBudgetBytes,
    private st: CacheWriteState = writeState,
  ) {}
  async get(key: string) {
    if (redisDegraded()) return undefined; // save commands / latency while Redis is down or over plan
    try {
      const v = await this.redis.get<string>(redisCacheKey(key));
      if (v == null) return undefined;
      const s = String(v);
      // Redis read volume (bytes on the wire) is charged to the call's quota (bandwidth bound, see settleQuota).
      const ctx = currentContext();
      if (ctx) ctx.redisReadBytes = (ctx.redisReadBytes ?? 0) + Buffer.byteLength(s, "utf8");
      return decodeFromRedis(s);
    } catch (e) {
      markRedisDegraded(e);
      return undefined; // cache failures must never break tools
    }
  }
  /** First write of the day on this instance: read the fleet counter once (shared by concurrent writes). */
  private syncCounter(bkey: string, day: string, now: number): Promise<boolean> {
    const st = this.st;
    if (st.syncedDay === day) return Promise.resolve(true);
    if (st.sync?.day === day) return st.sync.p;
    const p = this.redis.get<string>(bkey).then(
      (v) => {
        if (st.day === day) {
          const fleet = Number(v ?? 0);
          if (Number.isFinite(fleet)) st.known = Math.max(st.known, fleet + st.pending);
          st.syncedDay = day;
        }
        st.sync = undefined;
        return true;
      },
      (e) => {
        st.sync = undefined; // retried by a later write
        onWriteError(st, e, now);
        return false;
      },
    );
    st.sync = { day, p };
    return p;
  }
  private async runScript(keys: string[], args: string[]): Promise<unknown> {
    try {
      return await this.redis.evalsha(CACHE_WRITE_SCRIPT_SHA, keys, args);
    } catch (e) {
      if (!/NOSCRIPT/i.test(String(e))) throw e;
      return await this.redis.eval(CACHE_WRITE_SCRIPT, keys, args);
    }
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (redisDegraded() || this.budgetBytes <= 0) return;
    const st = this.st;
    const now = Date.now();
    if (now < st.fullUntil) return; // "redis full": 0 commands
    const day = rollDay(st, now);
    if (st.exhausted) return; // budget exhausted until UTC midnight: 0 commands
    if (value.length > REDIS_COMPRESS_MAX_RATIO * this.maxValueBytes) return; // can't fit: don't spend CPU on gzip
    const stored = encodeForRedis(value);
    const rkey = redisCacheKey(key);
    const storedBytes = Buffer.byteLength(stored, "utf8");
    if (storedBytes > this.maxValueBytes) return;
    const bytes = storedBytes + Buffer.byteLength(rkey, "utf8") + REDIS_ENTRY_OVERHEAD_BYTES;
    const bkey = `${config().cachePrefix}cw:${day}`;
    if (!(await this.syncCounter(bkey, day, now))) return;
    if (st.day !== day || st.exhausted || Date.now() < st.fullUntil) return;
    if (st.known + bytes > this.budgetBytes) {
      st.exhausted = true; // local memo says no: 0 commands until the UTC day ends
      return;
    }
    st.known += bytes; // reserve before the await: concurrent writes on this instance see it
    st.pending += bytes;
    let res: unknown;
    try {
      res = await this.runScript([bkey, rkey], [String(bytes), String(this.budgetBytes), String(nextUtcMidnightSeconds(now) + 3600), String(redisTtlSeconds(ttlSeconds, now)), stored]);
    } catch (e) {
      onWriteError(st, e, now);
      return; // the reservation stays in `known` (conservative)
    } finally {
      st.pending -= bytes;
    }
    const [ok, total] = Array.isArray(res) ? res.map(Number) : [NaN, NaN];
    if (st.day !== day) return;
    if (Number.isFinite(total)) st.known = Math.max(st.known, total! + st.pending);
    if (ok === -1 || st.known >= this.budgetBytes) st.exhausted = true; // memoised until the UTC day ends
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
