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
process.env.QUOTA_ANON_NETWORK_PER_DAY = "12";
process.env.QUOTA_KEY_PER_MINUTE = "50";
process.env.QUOTA_KEY_PER_DAY = "8";
process.env.QUOTA_ANON_GLOBAL_PER_DAY = "16";
if (!process.env.IP_HASH_SALT) process.env.IP_HASH_SALT = randomBytes(24).toString("hex"); // throwaway, ≥32 chars

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
const ipB = { "x-real-ip": `203.0.113.${(parseInt(run, 16) % 200) + 1}` };

try {
  console.log(`prefix ${c.cachePrefix}`);
  // Warm the in-memory ticker cache so per-call Redis counts reflect quota + cache traffic only.
  await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": "192.0.2.1" });

  console.log("Anonymous per-IP minute quota (5 units/min)");
  let before = redisRequests;
  const r: boolean[] = [];
  for (let i = 0; i < 5; i++) r.push((await tool("search_company", { query: "AAPL", limit: 1 }, ipA)).limited);
  const perAllowed = (redisRequests - before) / 5;
  check(r.every((x) => !x), "5 x 1-unit calls allowed");
  before = redisRequests;
  const sixth = await tool("search_company", { query: "AAPL", limit: 1 }, ipA);
  const perBlocked = redisRequests - before;
  check(sixth.limited && /retry_after_seconds/.test(sixth.text), "6th call RATE_LIMITED with retry_after_seconds");
  before = redisRequests;
  const seventh = await tool("search_company", { query: "AAPL", limit: 1 }, ipA);
  check(seventh.limited, `7th call still limited`);
  const perRepeatBlocked0 = redisRequests - before;
  check(!(await tool("search_company", { query: "AAPL", limit: 1 }, ipB)).limited, "other IP unaffected");
  const perRepeatBlocked = perRepeatBlocked0;
  console.log(`  Upstash commands: ${perAllowed.toFixed(1)} per allowed call (warm cache), ${perBlocked} first blocked, ${perRepeatBlocked} repeat blocked`);
  check(perAllowed <= 1.01 && perRepeatBlocked === 0, "allowed = 1 command (single EVALSHA), repeat blocked = 0");

  console.log("Network /24 daily cap (12 units) against IP rotation");
  const base = `198.51.100.`;
  const rot: boolean[] = [];
  for (let i = 0; i < 8; i++) rot.push((await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": `${base}${210 + i}` })).limited);
  check(rot.slice(0, 7).every((x) => !x) && rot[7], `5 + 7 units from rotating IPs allowed, then refused (${rot.map((x) => (x ? "L" : ".")).join("")})`);

  console.log("Global anonymous daily cap (16 units across all IPs)");
  const g: boolean[] = [];
  for (let i = 0; i < 3; i++) g.push((await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": `192.0.2.${50 + i}` })).limited);
  before = redisRequests;
  const g2 = await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": "192.0.2.99" });
  check(g[0] === false && g[1] === false && g[2] === true && g2.limited && g2.text.includes("global"), `refused once the anonymous total is spent (${g.map((x) => (x ? "L" : ".")).join("")}), ${redisRequests - before} commands for a new IP after that`);

  console.log("Self-verifying API key (per-day 8 units)");
  const { key, id: keyId } = generateApiKey();
  await storeApiKey(redis, keyId, { created: new Date().toISOString().slice(0, 10) });
  const stored = await redis.get<string>(`${c.cachePrefix}apikey:${keyId}`);
  check(stored && !String(stored).includes(key) && !/name|contact/.test(String(stored)), "record holds no key, name or contact");
  const k = { authorization: `Bearer ${key}` };
  const rk: boolean[] = [];
  for (let i = 0; i < 8; i++) rk.push((await tool("search_company", { query: "AAPL", limit: 1 }, { ...k, ...ipA })).limited);
  check(rk.every((x) => !x), "key: 8 calls allowed even though the IP is over its anonymous quota");
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
  check(values.every((v) => /^\d+$/.test(String(v))), "all quota values are integers");
  const ttlOf = await Promise.all(quotaKeys.map(async (k) => [k, await redis.ttl(k)] as const));
  const dayT = ttlOf.filter(([k]) => k.includes(":q:d:")).map(([, t]) => t);
  const minT = ttlOf.filter(([k]) => k.includes(":q:m:")).map(([, t]) => t);
  check(dayT.length > 0 && dayT.every((t) => t > 0 && t <= 25 * 3600), `daily counters TTL <= 25 h (max ${Math.max(...dayT)} s)`);
  check(minT.every((t) => t > 0 && t <= 70), `minute counters TTL <= 70 s (max ${Math.max(0, ...minT)} s)`);
  const dump = JSON.stringify(all) + JSON.stringify(values) + JSON.stringify(await Promise.all(all.filter((k) => !k.includes(":q:")).map((k) => redis.get<string>(k))));
  const rawIps = [ipA["x-real-ip"], ipB["x-real-ip"], "198.51.100.", "203.0.113.", "192.0.2.1"];
  check(!rawIps.some((ip) => dump.includes(ip)), "no raw IP anywhere in keys or values");
  const other = all.filter((k) => !k.includes(":q:") && !k.includes(":apikey:"));
  check(other.every((k) => /:c:[0-9a-f]{40}$/.test(k)), `${other.length} cache keys, all hashed (no URLs or tool arguments in key names)`);
  const { ipPrincipal } = await import("../src/core/apiKeys.js");
  check(ipPrincipal("198.51.100.7", "20261020").id !== ipPrincipal("198.51.100.7", "20261021").id, "IP hash salt rotates daily");
  before = redisRequests;
  const bad = await tool("search_company", { query: "AAPL" }, { authorization: `Bearer eem_AAAAAAAAAAAA_${"0".repeat(24)}` });
  check(bad.status === 401 && redisRequests === before, `forged key -> 401 with 0 Redis commands (${bad.status}, ${redisRequests - before})`);
  const del = await deleteApiKey(redis, key);
  check(del.record && del.counters >= 1, `delete-key removed the record and ${del.counters} counters`);
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

  console.log("Degraded mode (Redis rejects requests)");
  const broken = new Redis({ url: c.upstashUrl, token: "invalid-token", automaticDeserialization: false });
  const lim2 = new RateLimiter(50, upstashTokenBucket(broken, 2, `livetest-${run}-b`), { name: "livetest", degradedRps: 1 });
  const t1 = Date.now();
  await lim2.acquire();
  await lim2.acquire();
  await lim2.acquire();
  check(redisDegraded() && Date.now() - t1 >= 1800, `limiter falls back to 1 rps locally instead of failing (${Date.now() - t1} ms for 3)`);
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
