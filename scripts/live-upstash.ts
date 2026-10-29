/**
 * Live check of the HTTP handler against a REAL Upstash database (quotas, hashed API keys,
 * token bucket, fail-closed). Uses a throwaway key prefix and deletes everything it wrote.
 * Counts Upstash commands (pipelined batches counted per command) per allowed / blocked call.
 *
 *   (set -a; . ./.env.live; set +a; SEC_USER_AGENT="Name you@x.com" npx tsx scripts/live-upstash.ts)
 */
import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";

const run = randomBytes(4).toString("hex");
process.env.CACHE_PREFIX = `eem:livetest-${run}:`;
process.env.QUOTA_ANON_PER_MINUTE = "5";
process.env.QUOTA_ANON_PER_DAY = "1000";
process.env.QUOTA_ANON_GLOBAL_PER_DAY = "20"; // => /24 cap 2 (10%)
process.env.QUOTA_ANON_GLOBAL_HARD_PER_DAY = "23";
process.env.QUOTA_ANON_TRICKLE_PER_DAY = "1";
process.env.QUOTA_KEY_PER_MINUTE = "50";
process.env.QUOTA_KEY_PER_DAY = "8";
// Throwaway secrets (>= 32 chars) for this run only.
process.env.IP_HASH_SALT = randomBytes(24).toString("hex");
process.env.API_KEY_SECRET = randomBytes(24).toString("hex");

const { config } = await import("../src/config.js");
const { createHttpHandler } = await import("../src/http/handler.js");
const { getRedis } = await import("../src/core/cache.js");
const { generateApiKey, storeApiKey, deleteApiKey, clearApiKeyMemo } = await import("../src/core/apiKeys.js");
const { UpstashQuotaStore, chargeQuota } = await import("../src/core/quota.js");
const { clearRedisDegraded, redisDegraded } = await import("../src/core/degraded.js");
const { RateLimiter, upstashTokenBucket } = await import("../src/core/rateLimiter.js");
const { check, failed } = await import("./lib.js");

const c = config();
if (!c.upstashUrl) throw new Error("Upstash env not loaded");
const host = new URL(c.upstashUrl).host;
/** Billed commands we can see from the client: REST commands (pipelines counted per command). Script-internal commands are added from the script's known shape below. */
let redisRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (u.includes(host)) {
    const b = JSON.parse(String(init?.body ?? "[]")) as unknown[];
    redisRequests += /\/(pipeline|multi-exec)$/.test(new URL(u).pathname) ? b.length : 1;
  }
  return realFetch(input, init);
}) as typeof fetch;

const redis = getRedis()!;
const handler = createHttpHandler();
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let id = 0;
async function tool(name: string, args: object, extra: Record<string, string>) {
  const res = await handler(
    new Request("https://preview.local/mcp", { method: "POST", headers: { ...hdr, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) }),
  );
  const t = await res.text();
  return { status: res.status, text: t, limited: t.includes("RATE_LIMITED") };
}
const ipA = { "x-real-ip": `198.51.100.${(parseInt(run, 16) % 200) + 1}` };

try {
  console.log(`prefix ${c.cachePrefix}`);
  // Warm the in-memory ticker cache so per-call Redis counts reflect quota + cache traffic only.
  await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": "192.0.2.1" });

  const q = (ip: string) => tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": ip });
  const net = (n: number, h = 1) => `100.${64 + Math.floor(n / 250)}.${n % 250}.${h}`; // distinct /24s (CGNAT range)

  console.log("Per-/24 cap (10% of the global budget = 2 units), memoised remaining");
  let before = redisRequests;
  const a1 = await q(net(1, 1));
  const a2 = await q(net(1, 2));
  const perAllowed = (redisRequests - before) / 2;
  before = redisRequests;
  const a3 = await q(net(1, 3));
  const perBlocked = redisRequests - before;
  before = redisRequests;
  const a4 = await q(net(1, 4));
  const perRepeat = redisRequests - before;
  check(!a1.limited && !a2.limited && a3.limited && a3.text.includes("network") && a4.limited, "2 units per /24, then refused (scope network)");
  check(perAllowed === 1 && perBlocked === 0 && perRepeat === 0, `REST commands: ${perAllowed} per allowed call (EVALSHA), ${perBlocked} for the first refused call (remaining known locally), ${perRepeat} repeat`);

  console.log("Soft global cap (20) with 1-unit trickle per IP, hard ceiling 23");
  for (let n = 2; n <= 9; n++) for (let h = 1; h <= 2; h++) await q(net(n, h)); // 1 warm + 2 + 16 = 19
  const s1 = await q(net(10, 1)); // 20 = soft cap
  const t1 = await q(net(11, 1)); // past soft cap: trickle (own counter 1 <= 1)
  const t1b = await q(net(11, 1)); // own counter would be 2 > trickle
  const t2 = await q(net(12, 1));
  const t3 = await q(net(13, 1)); // 23 = hard
  before = redisRequests;
  const t4 = await q(net(14, 1));
  const afterHard = redisRequests - before;
  check(!s1.limited && !t1.limited && t1b.limited && t1b.text.includes("global") && !t2.limited && !t3.limited && t4.limited, "soft cap → 1-unit trickle per IP → hard ceiling");
  check(afterHard === 0, `new IP after the hard ceiling: ${afterHard} REST commands`);

  console.log("Self-verifying API key (per-day 8 units)");
  const { key, id: keyId } = generateApiKey();
  await storeApiKey(redis, keyId, { created: new Date().toISOString().slice(0, 10) });
  const stored = await redis.get<string>(`${c.cachePrefix}apikey:${keyId}`);
  check(stored && !String(stored).includes(key) && !/name|contact/.test(String(stored)), "record holds no key, name or contact");
  const k = { authorization: `Bearer ${key}` };
  const rk: boolean[] = [];
  before = redisRequests;
  for (let i = 0; i < 8; i++) rk.push((await tool("search_company", { query: "AAPL", limit: 1 }, { ...k, ...ipA })).limited);
  check(rk.every((x) => !x), "key: 8 calls allowed even though anonymous budgets are spent");
  check(redisRequests - before === 1 + 8, `key: 1 GET (lookup, then memoised) + 1 EVALSHA per call (${redisRequests - before} REST commands for 8 calls)`);
  const over = await tool("search_company", { query: "AAPL", limit: 1 }, { ...k, ...ipA });
  check(over.limited && over.text.includes("day"), "key: 9th call RATE_LIMITED (daily)");
  console.log("Stored state: only integer counters under hashed ids, TTL = window");
  const all: string[] = [];
  let cur = "0";
  do {
    const [next, ks] = await redis.scan(cur, { match: `${c.cachePrefix}*`, count: 1000 });
    cur = String(next);
    all.push(...ks);
  } while (cur !== "0");
  const quotaKeys = all.filter((k) => k.includes(":q:"));
  check(!all.some((k) => k.includes(":u:")), "no usage hashes");
  check(quotaKeys.every((k) => /:q:[dm]:((ip|net|key):[0-9a-zA-Z]+|anon):\d+$/.test(k)), `${quotaKeys.length} quota keys, all hashed id / key id / anon total + window`);
  const values = await Promise.all(quotaKeys.map((k) => redis.get<string>(k)));
  check(values.every((v) => /^-?\d+$/.test(String(v))), "all quota values are integers");
  const ttlOf = await Promise.all(quotaKeys.map(async (k) => [k, await redis.ttl(k)] as const));
  const dayT = ttlOf.filter(([k]) => k.includes(":q:d:")).map(([, t]) => t);
  const minT = ttlOf.filter(([k]) => k.includes(":q:m:")).map(([, t]) => t);
  check(dayT.length > 0 && dayT.every((t) => t > 0 && t <= 25 * 3600), `daily counters TTL <= 25 h (max ${Math.max(...dayT)} s)`);
  check(minT.length === 0, "no per-minute counters in Redis (minute limits are in memory)");
  const dump = JSON.stringify(all) + JSON.stringify(values) + JSON.stringify(await Promise.all(all.filter((k) => !k.includes(":q:")).map((k) => redis.get<string>(k))));
  const rawIps = [ipA["x-real-ip"], "198.51.100.", "100.64.", "192.0.2.1"];
  check(!rawIps.some((ip) => dump.includes(ip)), "no raw IP anywhere in keys or values");
  const other = all.filter((k) => !k.includes(":q:") && !k.includes(":apikey:"));
  check(other.every((k) => /:(c:[0-9a-f]{40}|cw:\d{8})$/.test(k)), `${other.length} cache keys, all hashed (no URLs or tool arguments in key names) or the daily write-budget counter`);
  const { ipPrincipal } = await import("../src/core/apiKeys.js");
  check(ipPrincipal("198.51.100.7", "20261020").id !== ipPrincipal("198.51.100.7", "20261021").id, "IP hash salt rotates daily");
  before = redisRequests;
  const bad = await tool("search_company", { query: "AAPL" }, { authorization: `Bearer eem_AAAAAAAAAAAA_${"0".repeat(24)}` });
  check(bad.status === 401 && redisRequests === before, `forged key -> 401 with 0 Redis commands (${bad.status}, ${redisRequests - before})`);
  const del = await deleteApiKey(redis, key);
  check(del.record && del.counters >= 1, `delete-key removed the record and ${del.counters} counter(s)`);
  const { verifyApiKey } = await import("../src/core/apiKeys.js");
  clearApiKeyMemo();
  check((await verifyApiKey(key)) === null, "deleted key no longer verifies");
  check(!(await redis.get(`${c.cachePrefix}apikey:${keyId}`)), "nothing left for the key");
  clearApiKeyMemo();
  const revoked = await tool("search_company", { query: "AAPL" }, k);
  check(revoked.status === 401, `revoked key -> 401 (${revoked.status})`);

  console.log("Distributed token bucket (2 rps)");
  const lim = new RateLimiter(50, upstashTokenBucket(redis, 2, `livetest-${run}`), { name: "livetest", maxWaitMs: 8000, maxAttempts: 10 });
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) await lim.acquire();
  const el = Date.now() - t0;
  check(el >= 1500, `6 acquisitions at 2 rps (burst 2) took ${el} ms`);

  console.log("Cache guard (write budget, compression, 24 h TTL)");
  {
    const { UpstashCache, cacheBudgetKey, redisCacheKey, cacheWriteStatus, resetCacheWriteState, TTL } = await import("../src/core/cache.js");
    resetCacheWriteState();
    const tr = await realFetch("https://www.sec.gov/files/company_tickers_exchange.json", { headers: { "user-agent": c.secUserAgent, accept: "application/json" } });
    const raw = await tr.text();
    check(tr.ok && raw.length > 256 * 1024, `SEC ticker file fetched (${raw.length} bytes raw)`);
    const uc = new UpstashCache(redis, c.redisMaxValueBytes, c.cacheWriteBudgetBytes);
    let b0 = redisRequests;
    await uc.set("livetest:tickers", raw, TTL.tickers);
    check(redisRequests - b0 === 3, `first cache write of the day: ${redisRequests - b0} commands (INCRBY + EXPIREAT + SET)`);
    const rk = redisCacheKey("livetest:tickers");
    const stored = await redis.get<string>(rk);
    check(!!stored && stored.startsWith("\u0001gz1:") && stored.length <= c.redisMaxValueBytes, `ticker file stored gzip+base64: ${stored?.length} bytes (cap ${c.redisMaxValueBytes})`);
    const usage = await realFetch(c.upstashUrl!, { method: "POST", headers: { authorization: `Bearer ${c.upstashToken}` }, body: JSON.stringify(["MEMORY", "USAGE", rk]) }).then((r) => r.json() as Promise<{ result?: number }>);
    console.log(`  MEMORY USAGE of the compressed ticker entry: ${usage.result ?? "n/a"} bytes`);
    const ttl = await redis.ttl(rk);
    check(ttl > 0 && ttl <= 24 * 3600, `ticker entry TTL ${ttl} s (<= 24 h)`);
    b0 = redisRequests;
    check((await uc.get("livetest:tickers")) === raw && redisRequests - b0 === 1, `round trip decompresses to the original (${redisRequests - b0} command)`);
    b0 = redisRequests;
    await uc.set("livetest:small", JSON.stringify({ ok: 1 }), 7 * 24 * 3600);
    check(redisRequests - b0 === 2, `further cache write: ${redisRequests - b0} commands (INCRBY + SET)`);
    check((await redis.ttl(redisCacheKey("livetest:small"))) <= 24 * 3600, "a 7-day TTL request is capped at 24 h in Redis");
    const bk = cacheBudgetKey();
    const used = Number(await redis.get<string>(bk));
    const bttl = await redis.ttl(bk);
    check(used >= stored!.length && bttl > 0 && bttl <= 25 * 3600, `budget counter ${bk.replace(c.cachePrefix, "<prefix>")} = ${used} bytes, TTL ${bttl} s (<= 25 h)`);
    const tight = new UpstashCache(redis, c.redisMaxValueBytes, used + 100);
    await tight.set("livetest:x1", "y".repeat(200), 60); // would exceed: refused locally
    b0 = redisRequests;
    for (let i = 0; i < 20; i++) await tight.set(`livetest:x${i + 2}`, "z", 60);
    check(redisRequests === b0 && cacheWriteStatus().writes === "budget exhausted", `budget exhausted: 20 writes cost ${redisRequests - b0} commands`);
    b0 = redisRequests;
    check((await tight.get("livetest:small")) !== undefined && redisRequests - b0 === 1, "reads continue while the write budget is exhausted");
    resetCacheWriteState();
  }

  console.log("Degraded mode (Redis rejects requests)");
  const broken = new Redis({ url: c.upstashUrl, token: "invalid-token", automaticDeserialization: false });
  const lim2 = new RateLimiter(50, upstashTokenBucket(broken, 2, `livetest-${run}-b`), { name: "livetest", degradedRps: 1 });
  const d0 = Date.now();
  await lim2.acquire("key");
  await lim2.acquire("key");
  await lim2.acquire("key");
  check(redisDegraded() && Date.now() - d0 >= 1800, `keyed limiter falls back to the degraded local rate instead of failing (${Date.now() - d0} ms for 3 at 1 rps)`);
  clearRedisDegraded();
  const qs = new UpstashQuotaStore(broken);
  const ok = await chargeQuota({ id: "ip:livetestdegraded", tier: "anon", network: "net:livetestdegraded" }, "search_company", {}, qs).then(() => true, () => false);
  check(ok && redisDegraded(), "quota falls back to in-memory limits (no global outage)");
  clearRedisDegraded();
} finally {
  let deleted = 0;
  for (const pattern of [`eem:livetest-${run}:*`, `eem:rl*livetest-${run}*`]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: pattern, count: 1000 });
      cursor = String(next);
      if (keys.length) deleted += await redis.del(...keys);
    } while (cursor !== "0");
  }
  console.log(`cleanup: deleted ${deleted} test keys`);
}
console.log(failed() ? `\n${failed()} LIVE CHECK(S) FAILED` : "\nALL LIVE UPSTASH CHECKS PASSED");
process.exit(failed() ? 1 : 0);
