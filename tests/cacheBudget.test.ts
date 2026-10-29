/**
 * Redis cache guard (the Upstash database runs with eviction OFF): daily fleet-wide write budget,
 * 24 h max TTL, 256 KB max value with gzip, and "redis full" isolating only cache writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { loadConfig, resetConfig } from "../src/config.js";
import {
  CACHE_FULL_COOLDOWN_MS,
  CACHE_WRITE_SCRIPT_SHA,
  newCacheWriteState,
  MemoryCache,
  TTL,
  TieredCache,
  UpstashCache,
  cacheBudgetKey,
  cacheWriteStatus,
  decodeFromRedis,
  encodeForRedis,
  REDIS_COMPRESS_MAX_RATIO,
  REDIS_ENTRY_OVERHEAD_BYTES,
  redisCacheKey,
  redisTtlSeconds,
  resetCacheWriteState,
} from "../src/core/cache.js";
import { UpstashQuotaStore, chargeQuota, type Principal } from "../src/core/quota.js";
import { degradedStatus, isRedisCapacityError, redisDegraded } from "../src/core/degraded.js";
import { ipPrincipal, clearSaltMemo } from "../src/core/apiKeys.js";
import { healthPayload, healthResponse } from "../src/http/health.js";
import { runWithContext } from "../src/core/context.js";
import { REDIS_READ_BYTES_PER_UNIT, settleQuota } from "../src/core/quota.js";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";

const SALT = "budget-test-secret-0123456789abcdefghij";
const ENV = { SEC_USER_AGENT: "T t@example.org", IP_HASH_SALT: SALT, API_KEY_SECRET: "key-secret-abcdefghijklmnopqrstuvwxyz0123", UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t" };
let f: ReturnType<typeof fakeUpstash>;
let redis: Redis;
async function billed(fn: () => Promise<unknown>): Promise<number> {
  const before = f.billed.n;
  await fn().catch(() => undefined);
  return f.billed.n - before;
}
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetConfig(loadConfig(ENV));
  clearSaltMemo();
  f = fakeUpstash();
  vi.stubGlobal("fetch", f.fetchStub);
  redis = new Redis({ url: FAKE, token: "t", automaticDeserialization: false, enableAutoPipelining: false });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConfig(undefined);
});

describe("config defaults", () => {
  it("256 KB max value, 64 MiB/day write budget, 0 disables Redis cache writes", () => {
    const c = loadConfig({});
    expect(c.redisMaxValueBytes).toBe(256 * 1024);
    expect(c.cacheWriteBudgetBytes).toBe(64 * 1024 * 1024);
    // Example 250 MB Redis store: two days' budget (00:00-01:00 UTC worst case) + 1 MB for
    // counters, keys and suppression must leave >= 40 % headroom.
    expect(2 * c.cacheWriteBudgetBytes + 1e6).toBeLessThan(0.6 * 250e6);
    expect(loadConfig({ CACHE_WRITE_BUDGET_BYTES: "1000" }).cacheWriteBudgetBytes).toBe(1000);
    expect(loadConfig({ CACHE_WRITE_BUDGET_BYTES: "0" }).cacheWriteBudgetBytes).toBe(0);
    expect(loadConfig({ REDIS_MAX_VALUE_BYTES: "1000" }).redisMaxValueBytes).toBe(1000);
  });
});

describe("daily fleet-wide cache-write budget", () => {
  it("one atomic EVALSHA per write (+1 GET of the counter once per instance per day); the counter is created with a <= 25 h TTL", async () => {
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    expect(await billed(() => c.set("a", "x".repeat(100), 60))).toBe(6); // GET + EVALSHA{GET, SET NX EXAT, INCRBY, SET}
    expect(await billed(() => c.set("b", "y".repeat(100), 60))).toBe(4); // EVALSHA{GET, INCRBY, SET}
    const bk = cacheBudgetKey();
    expect(bk).toBe("eem:v1:cw:20261029");
    const counter = f.kv.get(bk)!;
    expect(Number(counter.v)).toBe(2 * (100 + redisCacheKey("a").length + REDIS_ENTRY_OVERHEAD_BYTES));
    expect(counter.ttl).toBe(12 * 3600 + 3600); // UTC midnight + 1 h, i.e. at most 25 h
    expect(f.commands.map((x) => String(x[0]).toLowerCase())).toEqual(["get", "evalsha", "evalsha"]);
    expect(f.internal).toEqual(["GET", "SET", "INCRBY", "SET", "GET", "INCRBY", "SET"]);
    const ev = f.commands[1]!.map(String).slice(1);
    expect(ev[0]).toBe(CACHE_WRITE_SCRIPT_SHA);
    expect(ev.slice(1, 4)).toEqual(["2", bk, redisCacheKey("a")]);
    expect(ev.slice(4, 8)).toEqual([String(100 + redisCacheKey("a").length + REDIS_ENTRY_OVERHEAD_BYTES), "1000000", String(Math.floor(T0 / 1000) + 13 * 3600), "60"]);
    expect(await c.get("a")).toBe("x".repeat(100));
  });

  it("falls back to EVAL when the script is not loaded (NOSCRIPT)", async () => {
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    f.state.noscript = true;
    await c.set("a", "x", 60);
    expect(f.commands.map((x) => String(x[0]).toLowerCase())).toEqual(["get", "evalsha", "eval"]);
    expect(f.kv.get(redisCacheKey("a"))?.v).toBe("x");
    expect(redisDegraded()).toBe(false);
    await c.set("b", "y", 60);
    expect(String(f.commands.at(-1)![0]).toLowerCase()).toBe("evalsha");
  });

  it("once exhausted: 0 commands for writes until UTC midnight, reads continue", async () => {
    const c = new UpstashCache(redis, 10_000, 1000);
    const v = "v".repeat(300);
    await c.set("k1", v, 60);
    await c.set("k2", v, 60); // ~700 bytes used
    expect(await billed(() => c.set("k3", v, 60))).toBe(0); // would exceed: refused locally
    expect(cacheWriteStatus().writes).toBe("budget exhausted");
    expect(await billed(() => c.set("tiny", "t", 60))).toBe(0); // memoised: 0 commands for the rest of the day
    for (let i = 0; i < 50; i++) await c.set(`more${i}`, "t", 60);
    expect(await billed(async () => undefined)).toBe(0);
    expect(f.kv.has(redisCacheKey("k3"))).toBe(false);
    expect(await billed(() => c.get("k1"))).toBe(1); // reads still go to Redis
    expect(await c.get("k1")).toBe(v);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 0, 0, 1)); // next UTC day
    expect(cacheWriteStatus().writes).toBe("ok");
    expect(await billed(() => c.set("k3", v, 60))).toBe(6); // new day: GET + EVALSHA{GET, SET NX EXAT, INCRBY, SET}
    expect(f.kv.has("eem:v1:cw:20261030")).toBe(true);
  });

  it("is fleet-wide: a fresh instance reads the counter first and refuses locally without sending the value", async () => {
    const c = new UpstashCache(redis, 10_000, 10_000);
    f.kv.set(cacheBudgetKey(), { v: "9990", ttl: 3600 }); // the rest of the fleet wrote ~10 KB today
    expect(await billed(() => c.set("a", "x".repeat(50), 60))).toBe(1); // 1 GET of the counter, no EVALSHA
    expect(f.kv.has(redisCacheKey("a"))).toBe(false);
    expect(cacheWriteStatus().writes).toBe("budget exhausted");
    expect(await billed(() => c.set("b", "x", 60))).toBe(0);
    expect(f.kv.get(cacheBudgetKey())!.v).toBe("9990");
  });

  it("the script refuses (and nothing is written) when other instances filled the counter after this one synced", async () => {
    const c = new UpstashCache(redis, 10_000, 10_000);
    await c.set("warm", "w", 60); // synced: known ~146
    f.kv.set(cacheBudgetKey(), { v: "9990", ttl: 3600 }); // the fleet fills the counter meanwhile
    expect(await billed(() => c.set("a", "x".repeat(50), 60))).toBe(2); // EVALSHA{GET} -> -1, no INCRBY, no SET
    expect(f.kv.has(redisCacheKey("a"))).toBe(false);
    expect(f.kv.get(cacheBudgetKey())!.v).toBe("9990");
    expect(cacheWriteStatus().writes).toBe("budget exhausted"); // memoised until the UTC day ends
    expect(await billed(() => c.set("b", "x", 60))).toBe(0);
    vi.setSystemTime(Date.UTC(2026, 9, 30, 0, 0, 1));
    expect(cacheWriteStatus().writes).toBe("ok");
  });

  it("CACHE_WRITE_BUDGET_BYTES=0 disables Redis cache writes (0 commands), memory tier still works", async () => {
    resetConfig(loadConfig({ ...ENV, CACHE_WRITE_BUDGET_BYTES: "0" }));
    const t = new TieredCache(new MemoryCache(), new UpstashCache(redis, 10_000));
    expect(await billed(() => t.set("a", "1", 60))).toBe(0);
    expect(await t.get("a")).toBe("1");
    expect((healthPayload(ENV_WITH({ CACHE_WRITE_BUDGET_BYTES: "0" })).redis_cache as { writes: string }).writes).toBe("disabled");
  });

  it("quota refusals still cost 0 commands while cache writes are refused", async () => {
    const c = new UpstashCache(redis, 10_000, 10);
    await c.set("a", "x".repeat(100), 60); // over budget: refused locally
    const store = new UpstashQuotaStore(redis);
    const p: Principal = { id: "key:abcdefghijkl", tier: "key", perDay: 3, perMinute: 1_000_000 };
    for (let i = 0; i < 3; i++) await chargeQuota(p, "search_company", {}, store);
    expect(await billed(() => chargeQuota(p, "search_company", {}, store))).toBe(0);
    expect(await billed(() => chargeQuota(anon(1), "search_company", {}, store))).toBeGreaterThan(0); // allowed calls still counted
  });
});
const anon = (i: number) => ipPrincipal(`10.0.0.${i}`);
const ENV_WITH = (x: Record<string, string>) => ({ ...ENV, ...x }) as NodeJS.ProcessEnv;

describe("TTLs", () => {
  it("documents and parsed Form 4s live 24 h; Redis TTL is capped at 24 h and at next UTC midnight + 1 h", async () => {
    expect(TTL.filingDocShared).toBe(24 * 3600);
    expect(TTL.filingDoc).toBe(24 * 3600);
    expect(Math.max(...Object.values(TTL))).toBeLessThanOrEqual(24 * 3600);
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    await c.set("doc", "text", 7 * 24 * 3600); // 12:00 UTC: 13 h to 01:00 UTC next day
    expect(f.kv.get(redisCacheKey("doc"))!.ttl).toBe(13 * 3600);
    await c.set("short", "text", 600); // shorter normal TTL wins
    expect(f.kv.get(redisCacheKey("short"))!.ttl).toBe(600);
    expect(redisTtlSeconds(24 * 3600, Date.UTC(2026, 9, 29, 23, 0))).toBe(2 * 3600);
    expect(redisTtlSeconds(24 * 3600, Date.UTC(2026, 9, 29, 0, 0, 0))).toBe(24 * 3600); // 24 h cap
    expect(redisTtlSeconds(6 * 3600, Date.UTC(2026, 9, 29, 23, 59, 59))).toBe(3601);
    expect(redisTtlSeconds(0)).toBe(1);
    expect(redisTtlSeconds(NaN)).toBe(1); // non-finite TTLs never reach Redis
    expect(redisTtlSeconds(-Infinity)).toBe(1);
    expect(redisTtlSeconds(Infinity, Date.UTC(2026, 9, 29, 0, 0, 0))).toBe(24 * 3600);
    await c.set("nan", "text", NaN);
    expect(f.kv.get(redisCacheKey("nan"))!.ttl).toBe(1);
  });
});

describe("max value size and compression", () => {
  // Same shape as https://www.sec.gov/files/company_tickers_exchange.json (~520-585 KB).
  const tickers = () => {
    const ex = ["Nasdaq", "NYSE", "OTC", "CBOE", null];
    const words = ["Holdings", "Inc.", "Corp", "Group", "Capital", "Energy", "Bio", "Therapeutics", "Bancorp", "Trust", "Technologies", "Acquisition", "Partners", "LP", "Ltd"];
    const data: unknown[][] = [];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; data.length < 10_500; i++) {
      const name = `${String.fromCharCode(65 + rnd(26))}${"abcdefghijklmnopqrstuvwxyz".slice(rnd(10), 4 + rnd(12))} ${words[rnd(words.length)]} ${words[rnd(words.length)]}`;
      const tick = Array.from({ length: 1 + rnd(4) }, () => String.fromCharCode(65 + rnd(26))).join("");
      data.push([1_000_000 + rnd(900_000) * 2 + i, name, tick, ex[rnd(ex.length)]]);
    }
    return JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data });
  };

  it("company_tickers-sized JSON (> 256 KB raw) is stored gzip-compressed under the cap and round-trips", async () => {
    const raw = tickers();
    expect(raw.length).toBeGreaterThan(256 * 1024);
    const c = new UpstashCache(redis, 256 * 1024, 150 * 1024 * 1024);
    expect(await billed(() => c.set("tickers", raw, TTL.tickers))).toBe(6);
    const stored = f.kv.get(redisCacheKey("tickers"))!.v;
    expect(stored.startsWith("\u0001gz1:")).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(256 * 1024);
    expect(stored.length).toBeLessThan(raw.length / 2);
    expect(Number(f.kv.get(cacheBudgetKey())!.v)).toBe(stored.length + redisCacheKey("tickers").length + REDIS_ENTRY_OVERHEAD_BYTES); // budget counts stored bytes
    expect(await c.get("tickers")).toBe(raw);
  });

  it("values still too large after compression are kept in memory only (0 Redis commands)", async () => {
    const c = new UpstashCache(redis, 256 * 1024, 150 * 1024 * 1024);
    const noise = randomBytes(225_000).toString("base64"); // 300 KB, incompressible
    expect(await billed(() => c.set("big", noise, 60))).toBe(0);
    const t = new TieredCache(new MemoryCache(), c);
    await t.set("big", noise, 60);
    expect(await t.get("big")).toBe(noise);
  });

  it("small values are stored as-is, legacy uncompressed values read fine, corrupt compressed values are a miss", async () => {
    expect(encodeForRedis('{"a":1}')).toBe('{"a":1}');
    const big = JSON.stringify({ x: "a".repeat(20_000) });
    expect(decodeFromRedis(encodeForRedis(big))).toBe(big);
    expect(decodeFromRedis(big)).toBe(big);
    expect(decodeFromRedis("\u0001gz1:not-gzip")).toBeUndefined();
  });
});

describe("'redis full' (eviction off, data-size limit reached) disables only cache writes", () => {
  it("classifies capacity errors precisely", () => {
    expect(isRedisCapacityError(new Error("ERR DB capacity quota exceeded"))).toBe(true);
    expect(isRedisCapacityError("Command 2 [ set ] failed: ERR DB capacity quota exceeded")).toBe(true);
    expect(isRedisCapacityError("OOM command not allowed when used memory > 'maxmemory'.")).toBe(true);
    expect(isRedisCapacityError("ERR max requests limit exceeded. Limit: 500000, Usage: 500000.")).toBe(false);
    expect(isRedisCapacityError("ERR max daily bandwidth limit exceeded")).toBe(false);
    expect(isRedisCapacityError("fetch failed")).toBe(false);
  });

  it("a capacity error on a cache write switches cache writes off locally for 10 min; quotas, reads unaffected", async () => {
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    await c.set("before", "old", 600);
    f.state.full = true;
    await c.set("a", "1", 60);
    expect(cacheWriteStatus().writes).toBe("redis full");
    expect(redisDegraded()).toBe(false); // NOT degraded mode
    expect((healthPayload(ENV_WITH({})).redis_cache as { writes: string }).writes).toBe("redis full");
    expect(healthPayload(ENV_WITH({})).status).toBe("ok");
    expect(await billed(() => c.set("b", "2", 60))).toBe(0); // 0 commands while "redis full"
    expect(await c.get("before")).toBe("old"); // reads continue
    // The quota script is a write too; it keeps its own fail-closed/degraded handling unchanged.
    f.state.full = false;
    const store = new UpstashQuotaStore(redis);
    const p: Principal = { id: "key:abcdefghijkl", tier: "key", perDay: 100, perMinute: 1_000_000 };
    expect(await billed(() => chargeQuota(p, "search_company", {}, store))).toBe(3); // EVALSHA + INCRBY + EXPIRE (first of day)
    vi.setSystemTime(T0 + CACHE_FULL_COOLDOWN_MS + 1);
    expect(cacheWriteStatus().writes).toBe("ok");
    expect(await billed(() => c.set("b", "2", 60))).toBe(4); // EVALSHA{GET, INCRBY, SET}
  });

  it("a capacity error from the quota script still enters degraded mode (fail-closed path unchanged), reported as 'redis full'", async () => {
    f.state.full = true;
    const store = new UpstashQuotaStore(redis);
    await chargeQuota(anon(9), "search_company", {}, store).catch(() => undefined);
    expect(redisDegraded()).toBe(true);
    expect(degradedStatus().reason).toBe("redis full");
  });

  it("plan limits and outages on a cache write keep the existing degraded handling", async () => {
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    f.state.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000.";
    await c.set("a", "1", 60);
    expect(redisDegraded()).toBe(true);
    expect(degradedStatus().reason).toBe("redis plan limit reached");
    expect(cacheWriteStatus().writes).toBe("ok");
  });
});

describe("review fixes: concurrency, counter TTL, gzip guard, health privacy, read bytes", () => {
  it("50 concurrent writes against a small budget never exceed the budget plus one write", async () => {
    const budget = 5_000;
    const c = new UpstashCache(redis, 10_000, budget);
    const one = 100 + redisCacheKey("c00").length + REDIS_ENTRY_OVERHEAD_BYTES;
    await Promise.all(Array.from({ length: 50 }, (_, i) => c.set(`c${String(i).padStart(2, "0")}`, "z".repeat(100), 60)));
    const used = Number(f.kv.get(cacheBudgetKey())!.v);
    expect(used).toBeLessThanOrEqual(budget + one);
    expect(used).toBeLessThanOrEqual(budget); // one instance: the local reservation alone keeps it under
    const stored = Array.from({ length: 50 }, (_, i) => redisCacheKey(`c${String(i).padStart(2, "0")}`)).filter((k) => f.kv.has(k)).length;
    expect(stored).toBeGreaterThan(0);
    expect(stored * one).toBe(used);
    expect(cacheWriteStatus().writes).toBe("budget exhausted");
  });

  it("10 fresh instances x 50 concurrent writes against a full counter: 0 writes", async () => {
    const budget = 5_000;
    f.kv.set(cacheBudgetKey(), { v: String(budget), ttl: 3600 }); // counter already full
    const fleet = Array.from({ length: 10 }, () => newCacheWriteState()); // known = 0 on every instance
    const caches = fleet.map((st) => new UpstashCache(redis, 10_000, budget, st));
    const keys = (i: number) => Array.from({ length: 50 }, (_, j) => `f${i}-${j}`);
    await Promise.all(caches.flatMap((c, i) => keys(i).map((k) => c.set(k, "z".repeat(100), 60))));
    expect(f.kv.get(cacheBudgetKey())!.v).toBe(String(budget));
    expect([...f.kv.keys()].filter((k) => k.includes(":c:"))).toEqual([]);
    expect(fleet.every((st) => st.exhausted)).toBe(true);
    // The same with stale memos (each instance synced while the counter was empty): the atomic
    // script refuses every write, nothing is stored and the counter is unchanged.
    f.kv.delete(cacheBudgetKey());
    const stale = Array.from({ length: 10 }, () => newCacheWriteState());
    const sc = stale.map((st) => new UpstashCache(redis, 10_000, budget, st));
    await Promise.all(sc.map((c, i) => c.set(`warm${i}`, "w", 60)));
    f.kv.set(cacheBudgetKey(), { v: String(budget), ttl: 3600 });
    const before = f.internal.filter((x) => x === "SET").length;
    await Promise.all(sc.flatMap((c, i) => keys(i).map((k) => c.set(k, "z".repeat(100), 60))));
    expect(f.internal.filter((x) => x === "SET").length).toBe(before); // no value SET, no counter SET
    expect(f.kv.get(cacheBudgetKey())!.v).toBe(String(budget));
    for (let i = 0; i < 10; i++) for (const k of keys(i)) expect(f.kv.has(redisCacheKey(k))).toBe(false);
    expect(stale.every((st) => st.exhausted && st.pending === 0)).toBe(true);
  });

  it("10 instances x 50 concurrent writes from an empty counter never exceed the fleet budget", async () => {
    const one = 100 + redisCacheKey("x").length + REDIS_ENTRY_OVERHEAD_BYTES;
    const budget = 20 * one + 50; // room for 20 writes fleet-wide; each instance alone would allow 20
    const fleet = Array.from({ length: 10 }, () => newCacheWriteState());
    const caches = fleet.map((st) => new UpstashCache(redis, 10_000, budget, st));
    await Promise.all(caches.flatMap((c, i) => Array.from({ length: 50 }, (_, j) => c.set(`g${i}-${j}`, "z".repeat(100), 60))));
    const used = Number(f.kv.get(cacheBudgetKey())!.v);
    expect(used).toBeLessThanOrEqual(budget);
    const stored = [...f.kv.keys()].filter((k) => k.includes(":c:")).length;
    expect(stored).toBe(20);
    expect(stored * one).toBe(used);
    expect(fleet.every((st) => st.pending === 0)).toBe(true);
  });

  it("the memo counts this instance's in-flight writes on top of the fleet total", async () => {
    const st = newCacheWriteState();
    const c = new UpstashCache(redis, 10_000, 1_000_000, st);
    await c.set("warm", "w", 60);
    const one = 100 + redisCacheKey("x").length + REDIS_ENTRY_OVERHEAD_BYTES;
    const seen: number[] = [];
    vi.stubGlobal("fetch", (u: RequestInfo | URL, i?: RequestInit) => (seen.push(st.pending), f.fetchStub(u, i)));
    await Promise.all([c.set("p1", "z".repeat(100), 60), c.set("p2", "z".repeat(100), 60), c.set("p3", "z".repeat(100), 60)]);
    expect(Math.max(...seen)).toBe(3 * one); // all three reserved while in flight
    expect(st.pending).toBe(0);
    expect(st.known).toBeGreaterThanOrEqual(Number(f.kv.get(cacheBudgetKey())!.v));
  });

  it("the budget counter gets its TTL in the command that creates it (no separate EXPIREAT to fail)", async () => {
    const c = new UpstashCache(redis, 10_000, 1_000_000);
    await c.set("a", "x", 60);
    expect(f.commands.some((x) => String(x[0]).toLowerCase() === "expireat")).toBe(false);
    expect(f.kv.get(cacheBudgetKey())!.ttl).toBe(13 * 3600);
    // Another instance already created today's counter: SET NX is a no-op, the TTL is kept, INCRBY adds.
    f.kv.set(cacheBudgetKey(), { v: "500", ttl: 7200 });
    resetCacheWriteState();
    await c.set("b", "y", 60);
    expect(f.kv.get(cacheBudgetKey())!.ttl).toBe(7200);
    expect(Number(f.kv.get(cacheBudgetKey())!.v)).toBe(500 + 1 + redisCacheKey("b").length + REDIS_ENTRY_OVERHEAD_BYTES);
  });

  it("does not gzip values over 20x the max stored size (0 commands, no CPU spent)", async () => {
    const c = new UpstashCache(redis, 1000, 1_000_000);
    expect(REDIS_COMPRESS_MAX_RATIO).toBe(20);
    expect(await billed(() => c.set("huge", "a".repeat(20_001), 60))).toBe(0); // would compress to << 1000, but is skipped
    expect(await billed(() => c.set("ok", "a".repeat(19_999), 60))).toBe(6); // compressible and under 20x: stored (first write of the day)
    expect(f.kv.get(redisCacheKey("ok"))!.v.startsWith("\u0001gz1:")).toBe(true);
  });

  it("/health shows 'budget exhausted' only with HEALTH_SECRET", async () => {
    const env = ENV_WITH({ HEALTH_SECRET: "health-secret-0123456789" });
    resetConfig(loadConfig(env));
    const c = new UpstashCache(redis, 10_000, 100);
    await c.set("a", "x".repeat(200), 60);
    expect(cacheWriteStatus().writes).toBe("budget exhausted");
    const pub = healthPayload(env).redis_cache as Record<string, unknown>;
    expect(pub.writes).toBe("on");
    expect(JSON.stringify(pub)).not.toMatch(/exhaust|known_used/);
    const anonRes = await healthResponse(new Request("https://x/health?deep=1"), env);
    expect(anonRes.status).toBe(401);
    expect(await anonRes.text()).not.toMatch(/exhaust|redis_write_budget/);
    const priv = await (await healthResponse(new Request("https://x/health?deep=1", { headers: { "x-health-secret": "health-secret-0123456789" } }), env)).json();
    expect(priv.redis_write_budget.state).toBe("exhausted");
    expect(priv.redis_write_budget.until).toBe("2026-10-30T00:00:00.000Z");
  });

  it("Redis cache bytes read count toward the call's actual cost (bandwidth bound), capped at the estimate", async () => {
    const c = new UpstashCache(redis, 10 * 1024 * 1024, 1_000_000);
    f.kv.set(redisCacheKey("big"), { v: "b".repeat(2 * REDIS_READ_BYTES_PER_UNIT + 1) });
    const refunds: number[] = [];
    const settle = (cost: number) =>
      runWithContext({ transport: "http" }, async () => {
        const ctx = (await import("../src/core/context.js")).currentContext()!;
        ctx.reservation = { p: anon(9), cost, limits: {}, store: { refund: (_p: unknown, back: number) => refunds.push(back) }, at: Date.now() };
        await c.get("big");
        settleQuota();
      });
    await settle(5);
    expect(refunds).toEqual([2]); // 3 units charged: ceil(2 * 256 KiB + 1 / 256 KiB)
    await settle(2);
    expect(refunds).toEqual([2]); // capped at the 2-unit estimate: nothing refunded
  });

  it("read bytes are counted in UTF-8 bytes, not UTF-16 string length", async () => {
    const c = new UpstashCache(redis, 10 * 1024 * 1024, 1_000_000);
    const v = "\u20ac".repeat(1000); // 1000 chars, 3000 UTF-8 bytes
    f.kv.set(redisCacheKey("eur"), { v });
    const bytes = await runWithContext({ transport: "http" }, async () => {
      const ctx = (await import("../src/core/context.js")).currentContext()!;
      expect(await c.get("eur")).toBe(v);
      return ctx.redisReadBytes;
    });
    expect(bytes).toBe(3000);
  });
});
