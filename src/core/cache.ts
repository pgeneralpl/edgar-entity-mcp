import { LRUCache } from "lru-cache";
import { Redis } from "@upstash/redis";
import { config } from "../config.js";

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

export class UpstashCache implements Cache {
  readonly kind = "upstash";
  constructor(
    readonly redis: Redis,
    private maxValueBytes: number,
  ) {}
  async get(key: string) {
    try {
      const v = await this.redis.get<string>(key);
      return v ?? undefined;
    } catch {
      return undefined; // cache failures must never break tools
    }
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (value.length > this.maxValueBytes) return;
    try {
      await this.redis.set(key, value, { ex: Math.max(1, Math.round(ttlSeconds)) });
    } catch {
      /* ignore */
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
  filingDoc: 30 * 24 * 3600, // filed documents are immutable (memory tier only for raw bodies)
  filingDocShared: 7 * 24 * 3600, // processed/trimmed text and parsed Form 4s in Redis
  stateSearch: 3600,
} as const;
