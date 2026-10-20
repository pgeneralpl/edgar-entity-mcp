/**
 * Live check of the HTTP handler against a REAL Upstash database (quotas, hashed API keys,
 * token bucket, fail-closed). Uses a throwaway key prefix and deletes everything it wrote.
 * Counts Upstash REST requests to estimate command usage per call.
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

const { config } = await import("../src/config.js");
const { createHttpHandler } = await import("../src/http/handler.js");
const { getRedis } = await import("../src/core/cache.js");
const { generateApiKey, storeApiKey, revokeApiKey, clearApiKeyMemo, sha256 } = await import("../src/core/apiKeys.js");
const { RateLimiter, upstashTokenBucket } = await import("../src/core/rateLimiter.js");
const { check, failed } = await import("./lib.js");

const c = config();
if (!c.upstashUrl) throw new Error("Upstash env not loaded");
const host = new URL(c.upstashUrl).host;
let redisRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (u.includes(host)) redisRequests++;
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
  check(seventh.limited, `7th call still limited (Redis requests: ${redisRequests - before}, ephemeral cache)`);
  check(!(await tool("search_company", { query: "AAPL", limit: 1 }, ipB)).limited, "other IP unaffected");
  console.log(`  Upstash requests: ${perAllowed.toFixed(1)} per allowed call, ${perBlocked} for first blocked call`);

  console.log("Network /24 daily cap (12 units) against IP rotation");
  const base = `198.51.100.`;
  const rot: boolean[] = [];
  for (let i = 0; i < 8; i++) rot.push((await tool("search_company", { query: "AAPL", limit: 1 }, { "x-real-ip": `${base}${210 + i}` })).limited);
  check(rot.slice(0, 7).every((x) => !x) && rot[7], `5 + 7 units from rotating IPs allowed, then refused (${rot.map((x) => (x ? "L" : ".")).join("")})`);

  console.log("Hashed API key from Redis (per-day 8 units)");
  const key = generateApiKey();
  const hash = await storeApiKey(redis, key, { name: "live-test", created: new Date().toISOString() });
  const stored = await redis.get<string>(`${c.cachePrefix}apikey:${hash}`);
  check(stored && !String(stored).includes(key) && hash === sha256(key), "only the hash/record is stored");
  const k = { authorization: `Bearer ${key}` };
  const rk: boolean[] = [];
  for (let i = 0; i < 8; i++) rk.push((await tool("search_company", { query: "AAPL", limit: 1 }, { ...k, ...ipA })).limited);
  check(rk.every((x) => !x), "key: 8 calls allowed even though the IP is over its anonymous quota");
  const over = await tool("search_company", { query: "AAPL", limit: 1 }, { ...k, ...ipA });
  check(over.limited && over.text.includes("day"), "key: 9th call RATE_LIMITED (daily)");
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const scan = await redis.scan(0, { match: `${c.cachePrefix}u:*${day}`, count: 1000 });
  check(scan[1].length >= 2, `durable usage hashes written (${scan[1].length})`);
  const ttls = await Promise.all(scan[1].map((x) => redis.ttl(x)));
  check(ttls.every((t) => t > 0 && t <= 35 * 86400), `usage counters have TTLs (${ttls.join(", ")}s)`);
  const bad = await tool("search_company", { query: "AAPL" }, { authorization: "Bearer eem_" + "x".repeat(32) });
  check(bad.status === 401, `unknown key -> 401 (${bad.status})`);
  await revokeApiKey(redis, key);
  clearApiKeyMemo();
  const revoked = await tool("search_company", { query: "AAPL" }, k);
  check(revoked.status === 401, `revoked key -> 401 (${revoked.status})`);

  console.log("Distributed token bucket (2 rps)");
  const lim = new RateLimiter(50, upstashTokenBucket(redis, 2, `livetest-${run}`), { name: "livetest", maxWaitMs: 8000, maxAttempts: 10 });
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) await lim.acquire();
  const el = Date.now() - t0;
  check(el >= 1500, `6 acquisitions at 2 rps (burst 2) took ${el} ms`);

  console.log("Fail closed");
  const broken = new Redis({ url: c.upstashUrl, token: "invalid-token", automaticDeserialization: false });
  const lim2 = new RateLimiter(50, upstashTokenBucket(broken, 2, `livetest-${run}-b`), { name: "livetest" });
  const err = await lim2.acquire().then(() => null, (e: { code?: string }) => e);
  check(err?.code === "RATE_LIMITED", `limiter with unreachable/unauthorized Redis refuses (code ${err?.code})`);
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
