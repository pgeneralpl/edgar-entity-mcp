/**
 * Upstash free-plan budget. Counts BILLED Upstash commands (each REST command plus every
 * redis.call inside a Lua script) per kind of call, and checks degraded-mode behaviour.
 */
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { loadConfig, resetConfig } from "../src/config.js";
import { UpstashQuotaStore, MemoryQuotaStore, chargeQuota, settleQuota, setQuotaStore, type Principal } from "../src/core/quota.js";
import { clearApiKeyMemo, clearSaltMemo, deleteApiKey, generateApiKey, ipPrincipal, MAX_KEY_FAILURES, storeApiKey, verifyApiKey } from "../src/core/apiKeys.js";
import { markRedisDegraded, redisDegraded } from "../src/core/degraded.js";
import { callerIsTrusted, runWithContext, type CallContext } from "../src/core/context.js";
import { fetchRaw, resetLimiters } from "../src/core/http.js";
import { MemoryCache, TieredCache, UpstashCache, setCache } from "../src/core/cache.js";
import { RateLimiter } from "../src/core/rateLimiter.js";
import { createHttpHandler } from "../src/http/handler.js";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";

const SALT = "budget-test-secret-0123456789abcdefghij";
const KEYSECRET = "key-secret-abcdefghijklmnopqrstuvwxyz0123";
let f: ReturnType<typeof fakeUpstash>;
let redis: Redis;
const counts: Record<string, number> = {};
const env = (extra: Record<string, string> = {}) =>
  resetConfig(loadConfig({ SEC_USER_AGENT: "T t@example.org", IP_HASH_SALT: SALT, API_KEY_SECRET: KEYSECRET, UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t", ...extra }));
async function billed(label: string, fn: () => Promise<unknown>): Promise<number> {
  const before = f.billed.n;
  await fn().catch(() => undefined);
  const n = f.billed.n - before;
  counts[label] = n;
  return n;
}
const anon = (i: number, net = i) => ipPrincipal(`10.${Math.floor(net / 250)}.${net % 250}.${(i % 250) + 1}`);

beforeEach(() => {
  env();
  clearSaltMemo();
  clearApiKeyMemo();
  f = fakeUpstash();
  vi.stubGlobal("fetch", f.fetchStub);
  redis = new Redis({ url: FAKE, token: "t", automaticDeserialization: false, enableAutoPipelining: false });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setQuotaStore(undefined);
  setCache(undefined);
  resetLimiters();
  resetConfig(undefined);
  clearApiKeyMemo();
});

describe("billed Upstash commands per quota check", () => {
  it("anonymous allowed = 4 (EVALSHA + 3 INCRBY; +3 EXPIRE once per day), keyed allowed = 2", async () => {
    const store = new UpstashQuotaStore(redis);
    expect(await billed("anonymous allowed, first call of the day", () => chargeQuota(anon(1), "search_company", {}, store))).toBe(7);
    expect(await billed("anonymous allowed", () => chargeQuota(anon(1), "search_company", {}, store))).toBe(4);
    const k: Principal = { id: "key:abcdefghijkl", tier: "key" };
    await chargeQuota(k, "search_company", {}, store);
    expect(await billed("API key allowed", () => chargeQuota(k, "search_company", {}, store))).toBe(2);
    expect(f.internal.some((c) => /HINCRBY|MGET/.test(c))).toBe(false);
  });

  it("B1 regression: at 299/300, 300 cost-10 calls cost one script call, then 0; a 1-unit call still fits", async () => {
    const store = new UpstashQuotaStore(redis);
    const p: Principal = { id: "key:abcdefghijkl", tier: "key", perDay: 300, perMinute: 1_000_000 };
    for (let i = 0; i < 299; i++) await chargeQuota(p, "search_company", {}, store);
    // Remaining (1) is known from the last allowed call, so even the first over-limit call is local.
    const first = await billed("first over-limit call (remaining known locally)", () => chargeQuota(p, "get_filing_document", { company: "AAPL", accession: "x" }, store));
    expect(first).toBe(0);
    const before = f.billed.n;
    let refused = 0;
    for (let i = 0; i < 300; i++) await chargeQuota(p, "get_filing_document", { company: "AAPL", accession: "x" }, store).catch(() => refused++);
    expect(refused).toBe(300);
    counts["300 further over-limit calls (memoised remaining)"] = f.billed.n - before;
    expect(f.billed.n - before).toBe(0);
    await expect(chargeQuota(p, "search_company", {}, store)).resolves.toBeUndefined(); // 300/300
    expect(await billed("repeat blocked (day full)", () => chargeQuota(p, "search_company", {}, store))).toBe(0);
  });

  it("memoised remaining also covers the /24 and global counters (new IPs refused at 0 commands)", async () => {
    env({ QUOTA_ANON_GLOBAL_PER_DAY: "100", QUOTA_ANON_PER_MINUTE: "1000" }); // /24 cap = 10
    const store = new UpstashQuotaStore(redis);
    for (let i = 0; i < 10; i++) await chargeQuota(anon(i, 7), "search_company", {}, store);
    await expect(chargeQuota(anon(50, 7), "search_company", {}, store)).rejects.toMatchObject({ details: { scope: "network" } });
    expect(await billed("new IP in a full /24", () => chargeQuota(anon(51, 7), "search_company", {}, store))).toBe(0);
  });

  it("H2: cap per /24 is at most 10% of the global anonymous budget", () => {
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "1000", QUOTA_ANON_NETWORK_PER_DAY: "5000" }).quota.anonNetworkPerDay).toBe(100);
    expect(loadConfig({}).quota).toMatchObject({ anonPerDay: 60, anonGlobalPerDay: 600, anonNetworkPerDay: 60, anonGlobalHardPerDay: 900, anonTricklePerDay: 10, keyPerDay: 500 });
  });

  it("per-/24 default is 4x the per-IP cap, bounded by 10% of the global anonymous budget", () => {
    // Defaults: 4 x 60 = 240 > 10% of 600 = 60, so the 10% ceiling applies.
    expect(loadConfig({}).quota.anonNetworkPerDay).toBe(60);
    // Global budget large enough: the 4x per-IP default applies.
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "3000" }).quota.anonNetworkPerDay).toBe(240);
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "3000", QUOTA_ANON_PER_DAY: "50" }).quota.anonNetworkPerDay).toBe(200);
    // Exactly at the crossover (10% of 2,400 = 240 = 4 x 60).
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "2400" }).quota.anonNetworkPerDay).toBe(240);
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "2000" }).quota.anonNetworkPerDay).toBe(200);
    // An explicit value is honoured below the ceiling and clamped above it.
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "3000", QUOTA_ANON_NETWORK_PER_DAY: "120" }).quota.anonNetworkPerDay).toBe(120);
    expect(loadConfig({ QUOTA_ANON_GLOBAL_PER_DAY: "3000", QUOTA_ANON_NETWORK_PER_DAY: "1000" }).quota.anonNetworkPerDay).toBe(300);
  });

  it("per-/24 cap at 4x per-IP: four full IPs fit in one /24, a fifth is refused (scope network)", async () => {
    env({ QUOTA_ANON_GLOBAL_PER_DAY: "3000", QUOTA_ANON_PER_MINUTE: "100000" }); // /24 = min(4 x 60, 300) = 240
    const store = new UpstashQuotaStore(redis);
    for (let ip = 0; ip < 4; ip++) for (let i = 0; i < 60; i++) await chargeQuota(anon(ip, 9), "search_company", {}, store);
    await expect(chargeQuota(anon(4, 9), "search_company", {}, store)).rejects.toMatchObject({ details: { scope: "network" } });
    await expect(chargeQuota(anon(4, 10), "search_company", {}, store)).resolves.toBeUndefined(); // other /24 unaffected
  });

  it("H2: global cap is soft — past it every IP still gets a 10-unit trickle, up to the hard ceiling", async () => {
    env({ QUOTA_ANON_GLOBAL_PER_DAY: "200", QUOTA_ANON_GLOBAL_HARD_PER_DAY: "230", QUOTA_ANON_PER_MINUTE: "1000" }); // /24 = 20
    const store = new UpstashQuotaStore(redis);
    for (let n = 0; n < 10; n++) for (let i = 0; i < 20; i++) await chargeQuota(anon(n, n), "search_company", {}, store);
    // global soft cap (200) reached; a fresh IP in a fresh /24 gets 10 more units
    const late = anon(1, 100);
    for (let i = 0; i < 10; i++) await chargeQuota(late, "search_company", {}, store);
    await expect(chargeQuota(late, "search_company", {}, store)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { scope: "global" } });
    for (let i = 0; i < 10; i++) await chargeQuota(anon(2, 101), "search_company", {}, store); // 220
    for (let i = 0; i < 10; i++) await chargeQuota(anon(3, 102), "search_company", {}, store); // 230 = hard
    await expect(chargeQuota(anon(4, 103), "search_company", {}, store)).rejects.toMatchObject({ details: { scope: "global" } });
    expect(await billed("anonymous call after the hard global ceiling", () => chargeQuota(anon(5, 104), "search_company", {}, store))).toBe(0);
  });

  it("H2: reserve-then-refund — a cached call is charged 1 unit, the refund rides on the next INCRBY (0 extra commands)", async () => {
    const store = new UpstashQuotaStore(redis);
    const p: Principal = { id: "key:abcdefghijkl", tier: "key" };
    const ctx: CallContext = { principal: p, transport: "http", upstream: 0 };
    await runWithContext(ctx, async () => {
      await chargeQuota(p, "get_filing_document", { company: "AAPL", accession: "x" }, store); // reserve 10
      ctx.upstream = 0; // fully cached
      const b = f.billed.n;
      settleQuota();
      expect(f.billed.n - b).toBe(0);
    });
    const key = [...f.kv.keys()].find((k) => k.includes("q:d:key:"))!;
    expect(f.kv.get(key)!.v).toBe("10");
    expect(await billed("API key allowed, carrying a refund", () => chargeQuota(p, "search_company", {}, store))).toBe(2);
    expect(f.kv.get(key)!.v).toBe("2"); // 10 reserved − 9 refunded + 1
    // Same in memory (self-hosted / degraded): refund applied immediately.
    const mem = new MemoryQuotaStore();
    const ctx2: CallContext = { principal: p, transport: "http", upstream: 3 };
    await runWithContext(ctx2, async () => {
      await chargeQuota({ ...p, perDay: 12 }, "get_filing_document", { company: "AAPL", accession: "x" }, mem);
      settleQuota(); // actual 3
    });
    await expect(chargeQuota({ ...p, perDay: 12 }, "get_filing_document", { company: "AAPL", accession: "x" }, mem)).rejects.toMatchObject({ code: "RATE_LIMITED" }); // 3 + 10 > 12
    await expect(chargeQuota({ ...p, perDay: 12 }, "list_filings", { date_to: "2010-01-01" }, mem)).resolves.toBeUndefined(); // 3 + 6
  });

  it("end-to-end HTTP call (cold, 1 SEC request): quota + SEC token bucket + cache", async () => {
    resetLimiters();
    const mem = new MemoryCache();
    setCache(new TieredCache(mem, new UpstashCache(redis, 900_000)), new MemoryCache());
    const tickers = JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"]] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => (String(u).startsWith(FAKE) ? f.fetchStub(u, i) : new Response(tickers, { headers: { "content-type": "application/json" } }))),
    );
    const h = createHttpHandler({ quotaStore: new UpstashQuotaStore(redis) });
    const call = () =>
      h(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": "198.51.100.9" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_company", arguments: { query: "AAPL" } } }),
        }),
      );
    // cold, first call of the day: quota 4 + 3 EXPIRE, Redis cache GET (miss) 1, SEC token 4,
    // cache write 6 (GET of the budget counter once per instance per day + EVALSHA with GET,
    // SET NX EXAT (counter created), INCRBY, SET inside the script)
    const cold = await billed("HTTP search_company, cold, first call of the day (1 SEC request)", async () => (await call()).text());
    expect(cold).toBe(18);
    const warm = await billed("HTTP search_company, warm (process cache)", async () => (await call()).text());
    expect(warm).toBe(4);
    expect(cold).toBeGreaterThan(warm);
  });

  it("forged / random keys cost 0; MAC-valid unknown key 1 then 0; REVOKED_KEY_IDS 0", async () => {
    expect(await billed("random eem_ key", () => verifyApiKey("eem_" + "x".repeat(30)))).toBe(0);
    expect(await billed("forged key (bad MAC)", () => verifyApiKey(`eem_AAAAAAAAAAAA_${"0".repeat(24)}`))).toBe(0);
    const { key, id } = generateApiKey();
    expect(await billed("MAC-valid unknown key, first", () => verifyApiKey(key))).toBe(1);
    expect(await billed("MAC-valid unknown key, repeat", () => verifyApiKey(key))).toBe(0);
    const k2 = generateApiKey();
    await storeApiKey(redis, k2.id, { created: "2026-10-20" });
    env({ REVOKED_KEY_IDS: `${k2.id}, ${id}` });
    clearApiKeyMemo();
    expect(await billed("key in REVOKED_KEY_IDS", () => verifyApiKey(k2.key))).toBe(0);
    expect(await verifyApiKey(k2.key)).toBeNull();
  });

  it("valid stored key: 1 GET, then memoised; deletion removes the record and its counters", async () => {
    const { key, id } = generateApiKey();
    await storeApiKey(redis, id, { created: "2026-10-20", per_day: 50 });
    expect(JSON.stringify([...f.kv.entries()])).not.toMatch(/name|contact/i);
    expect(await billed("valid key, first", () => verifyApiKey(key))).toBe(1);
    expect(await billed("valid key, repeat", () => verifyApiKey(key))).toBe(0);
    const store = new UpstashQuotaStore(redis);
    await chargeQuota((await verifyApiKey(key))!, "search_company", {}, store);
    expect([...f.kv.keys()].some((k) => k.includes(`key:${id}:`))).toBe(true);
    const r = await deleteApiKey(redis, key);
    expect(r.record).toBe(true);
    expect(r.counters).toBe(1);
    expect([...f.kv.keys()].filter((k) => k.includes(id))).toEqual([]);
  });

  it("HTTP: bad keys → 401 without Redis, then 429 after repeated failures (0 commands)", async () => {
    const h = createHttpHandler({ quotaStore: new MemoryQuotaStore() });
    const call = (k: string) =>
      h(new Request("https://x/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${k}`, "x-real-ip": "203.0.113.50" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const before = f.billed.n;
    for (let i = 0; i < MAX_KEY_FAILURES; i++) expect((await call(`eem_AAAAAAAAAAA${i % 10}_${"0".repeat(24)}`)).status).toBe(401);
    expect((await call(`eem_BBBBBBBBBBBB_${"0".repeat(24)}`)).status).toBe(429);
    expect(f.billed.n - before).toBe(0);
  });
});

describe("degraded mode (M1, M2)", () => {
  it("Upstash plan limit → local in-memory quotas, then 0 commands during the cool-down", async () => {
    const store = new UpstashQuotaStore(redis);
    f.state.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000.";
    const p = anon(1);
    await expect(chargeQuota(p, "search_company", {}, store)).resolves.toBeUndefined();
    expect(redisDegraded()).toBe(true);
    expect(await billed("any call in degraded mode", () => chargeQuota(p, "search_company", {}, store))).toBe(0);
    let refused = false;
    for (let i = 0; i < 100 && !refused; i++) await chargeQuota(p, "search_company", {}, store).catch(() => (refused = true));
    expect(refused).toBe(true);
  });
  it("anonymous callers are cache-only; keyed callers continue; unverified keys are not trusted", async () => {
    markRedisDegraded(new Error("ERR max requests limit exceeded"));
    const sec = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", sec);
    const anonCtx: CallContext = { principal: anon(1), transport: "http" };
    await expect(runWithContext(anonCtx, () => fetchRaw("https://data.sec.gov/x.json", "sec"))).rejects.toMatchObject({ code: "RATE_LIMITED", details: { scope: "degraded" } });
    expect(sec).not.toHaveBeenCalled();
    const { key } = generateApiKey();
    const p = (await verifyApiKey(key))!;
    expect(p).toMatchObject({ tier: "key", unverified: true });
    await runWithContext({ principal: p, transport: "http" }, async () => {
      expect(callerIsTrusted()).toBe(false); // M2: no include_agent_details for unverified keys
      await fetchRaw("https://data.sec.gov/x.json", "sec");
    });
    expect(sec).toHaveBeenCalledTimes(1);
    expect(await runWithContext({ principal: { id: "key:x", tier: "key" }, transport: "http" }, async () => callerIsTrusted())).toBe(true);
  });
  it("DEGRADED_SEC_RPS defaults to 0.2; 0 means refuse", async () => {
    expect(loadConfig({}).degradedSecRps).toBe(0.2);
    expect(loadConfig({ DEGRADED_SEC_RPS: "0" }).degradedSecRps).toBe(0);
    markRedisDegraded(new Error("down"));
    const rl = new RateLimiter(100, { take: async () => ({ ok: true as const }) }, { degradedRps: 0 });
    await expect(rl.acquire("key")).rejects.toMatchObject({ code: "RATE_LIMITED", details: { scope: "degraded" } });
  });
  it("reports the measured billed-command counts", () => {
    if (process.env.BUDGET_REPORT) writeFileSync(process.env.BUDGET_REPORT, JSON.stringify(counts, null, 1));
    expect(Object.keys(counts).length).toBeGreaterThan(8);
  });
});
