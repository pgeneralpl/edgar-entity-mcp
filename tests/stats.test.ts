/**
 * Aggregate usage stats (src/core/stats.ts) and GET /stats (src/http/stats.ts): aggregation,
 * bounds, gating, failure tolerance and Redis command cost.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { loadConfig, resetConfig } from "../src/config.js";
import { clearApiKeyMemo, clearSaltMemo, ipPrincipal } from "../src/core/apiKeys.js";
import { markRedisDegraded, clearRedisDegraded } from "../src/core/degraded.js";
import { MemoryQuotaStore, type Principal } from "../src/core/quota.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import {
  bucketPercentile,
  flushStats,
  isoDay,
  latencyBucket,
  normalizeClient,
  readStats,
  recordInitialize,
  recordToolCall,
  resetStats,
  statsKeys,
  statsPending,
  STATS_FLUSH_INTERVAL_MS,
  STATS_MAX_PENDING_MEMBERS,
  STATS_TOP_CLIENTS,
  STATS_TTL_SECONDS,
} from "../src/core/stats.js";
import { statsResponse } from "../src/http/stats.js";
import { createHttpHandler } from "../src/http/handler.js";
import { resetLimiters } from "../src/core/http.js";
import type { UsageResult } from "../src/core/usage.js";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";

const SALT = "stats-test-secret-0123456789abcdefghijkl";
const SECRET = "s".repeat(20) + "0123456789abcdef0123456789abcdef0123456789ab";
const ENV = { SEC_USER_AGENT: "T t@example.org", IP_HASH_SALT: SALT, API_KEY_SECRET: "k".repeat(40), UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t", STATS_SECRET: SECRET };
let f: ReturnType<typeof fakeUpstash>;
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY = isoDay(T0);

const call = (over: Partial<UsageResult> = {}): UsageResult => ({
  tool: "search_company",
  transport: "http",
  ok: true,
  ms: 120,
  responseChars: 10,
  principal: ipPrincipal("203.0.113.7"),
  ...over,
});
const statsReq = (q = "", secret: string | null = SECRET) =>
  new Request(`https://x/stats${q}`, { headers: secret === null ? {} : { "x-stats-secret": secret } });

beforeEach(() => {
  resetConfig(loadConfig(ENV));
  clearSaltMemo();
  clearApiKeyMemo();
  f = fakeUpstash();
  vi.stubGlobal("fetch", f.fetchStub);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  resetStats({ enabled: true });
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetStats({ enabled: false });
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

/** Let the fire-and-forget flush started by a record* call finish. */
async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

describe("aggregation", () => {
  it("counts calls/ok/errors per tool, error codes, tiers, latency buckets and HLL members in one flush", async () => {
    const key: Principal = { id: "key:abcdefghijkl", tier: "key" };
    recordToolCall(call(), T0); // flushes immediately (first event) -> salt script + flush script
    await settle();
    const k = statsKeys(DAY);
    expect(f.hashes.get(k.c)?.get("calls:search_company")).toBe(1);
    const before = f.billed.n;
    recordToolCall(call({ ok: false, errorCode: "NOT_FOUND", ms: 4000 }), T0 + 1000);
    recordToolCall(call({ tool: "get_financials", principal: key, ms: 30 }), T0 + 2000);
    recordToolCall(call({ ok: false, errorCode: "weird code!", principal: key }), T0 + 3000);
    expect(f.billed.n).toBe(before); // coalesced: nothing written before the interval
    expect(statsPending().scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    const h = Object.fromEntries(f.hashes.get(k.c)!);
    expect(h).toMatchObject({
      "calls:search_company": 3,
      "ok:search_company": 1,
      "err:search_company": 2,
      "calls:get_financials": 1,
      "ok:get_financials": 1,
      "ec:NOT_FOUND": 1,
      "ec:OTHER": 1,
      "tier:anon": 2,
      "tier:key": 2,
      "lat:250": 2,
      "lat:5000": 1,
      "lat:50": 1,
    });
    expect(f.hlls.get(k.u)?.size).toBe(2); // one IP principal + one key principal
    expect(f.ttls.get(k.c)).toBe(STATS_TTL_SECONDS);
    expect(f.ttls.get(k.u)).toBe(STATS_TTL_SECONDS);
    // Second flush of the day: salt is memoised, so exactly one EVALSHA (+ inner commands).
    const top = f.commands.slice(-1);
    expect(String(top[0]?.[0]).toLowerCase()).toBe("evalsha");
  });

  it("never stores raw principals or IPs; HLL members are salted with a random per-day salt", async () => {
    const p = ipPrincipal("203.0.113.7");
    recordToolCall(call({ principal: p }), T0);
    recordInitialize({ id: "key:RAWKEYID1234", tier: "key" }, { name: "claude-ai", version: "0.1.0" }, T0);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    const dump = JSON.stringify([...f.commands, ...f.kv.entries()]);
    expect(dump).not.toContain("203.0.113.7");
    expect(dump).not.toContain(p.id);
    expect(dump).not.toContain(p.id.slice(3));
    expect(dump).not.toContain("RAWKEYID1234");
    const salt = f.kv.get(statsKeys(DAY).salt);
    expect(salt?.v).toMatch(/^[0-9a-f]{64}$/);
    expect(salt!.ttl!).toBeLessThanOrEqual(13 * 3600 + 60); // 12 h to UTC midnight + 1 h
    for (const m of f.hlls.get(statsKeys(DAY).u)!) expect(m).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records initialize sessions and normalized client names in a capped ZSET", async () => {
    recordInitialize(undefined, { name: "Claude Desktop <me@example.com>", version: "1.2.3; rm -rf" }, T0);
    await settle();
    expect(f.zsets.get(statsKeys(DAY).cl)?.get("Claude Desktop me.example.com/1.2.3 rm -rf")).toBeUndefined();
    const z = [...f.zsets.get(statsKeys(DAY).cl)!.keys()];
    expect(z).toHaveLength(1);
    expect(z[0]).not.toContain("@");
    expect(z[0]!.length).toBeLessThanOrEqual(64);
    expect(f.hashes.get(statsKeys(DAY).c)?.get("init")).toBe(1);
    // More distinct clients than the cap: Redis keeps only the top STATS_TOP_CLIENTS.
    for (let i = 0; i < STATS_TOP_CLIENTS + 30; i++) recordInitialize(undefined, { name: `client${i}`, version: "1" }, T0 + 1);
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(f.zsets.get(statsKeys(DAY).cl)!.size).toBeLessThanOrEqual(STATS_TOP_CLIENTS);
  });

  it("normalizeClient: safe charset, 64 chars, unknown when empty", () => {
    expect(normalizeClient({ name: "cursor", version: "1.7.0" })).toBe("cursor/1.7.0");
    expect(normalizeClient({})).toBe("unknown");
    expect(normalizeClient(null)).toBe("unknown");
    expect(normalizeClient({ name: "a@b.c\u0000<script>", version: 5 })).toBe("ab.cscript");
    expect(normalizeClient({ name: "x".repeat(200), version: "y".repeat(200) }).length).toBe(64);
  });

  it("ignores stdio calls and does nothing when STATS_ENABLED=0", async () => {
    recordToolCall(call({ transport: "stdio" }), T0);
    expect(statsPending().days).toBe(0);
    resetStats();
    resetConfig(loadConfig({ ...ENV, STATS_ENABLED: "0" }));
    recordToolCall(call(), T0);
    recordInitialize(undefined, { name: "x" }, T0);
    await settle();
    expect(statsPending().days).toBe(0);
    expect(f.billed.n).toBe(0);
  });
});

describe("bounds and cost", () => {
  it("a burst of N calls on one instance costs ≤ 2 script calls per flush interval", async () => {
    for (let i = 0; i < 1000; i++) recordToolCall(call({ principal: ipPrincipal(`198.51.${i % 200}.${(i % 250) + 1}`) }), T0 + i);
    await settle();
    const scripts = () => f.commands.filter((c) => /^eval/i.test(String(c[0]))).length;
    expect(scripts()).toBe(2); // salt (once per instance per day) + first flush
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(scripts()).toBe(3); // one trailing flush for the remaining 999 calls
    expect(f.hashes.get(statsKeys(DAY).c)?.get("calls:search_company")).toBe(1000);
    expect(f.hlls.get(statsKeys(DAY).u)!.size).toBeLessThanOrEqual(STATS_MAX_PENDING_MEMBERS + 1);
  });

  it("keeps at most 3 Redis keys per day (+1 salt) and bounded hash fields", async () => {
    for (let i = 0; i < 100; i++) recordToolCall(call({ tool: `Bad Tool ${i}`, ok: false, errorCode: `CODE_${i}` }), T0);
    recordInitialize(undefined, { name: "c" }, T0);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    const keys = [...f.hashes.keys(), ...f.hlls.keys(), ...f.zsets.keys(), ...[...f.kv.keys()].filter((k) => k.includes("stats:"))];
    expect(new Set(keys).size).toBe(4);
    const fields = [...f.hashes.get(statsKeys(DAY).c)!.keys()];
    expect(fields).toContain("calls:other");
    expect(fields).toContain("ec:OTHER");
    expect(fields.length).toBeLessThan(15);
  });

  it("uses one key set per UTC day", async () => {
    recordToolCall(call(), T0);
    await settle();
    const next = T0 + 86400_000;
    vi.setSystemTime(next);
    recordToolCall(call(), next);
    await settle();
    expect(f.hashes.has(statsKeys(DAY).c)).toBe(true);
    expect(f.hashes.has(statsKeys(isoDay(next)).c)).toBe(true);
  });
});

describe("failure tolerance", () => {
  it("Redis errors never throw, never mark Redis degraded, drop the batch and back off", async () => {
    f.state.failWith = "ERR something broke";
    expect(() => recordToolCall(call(), T0)).not.toThrow();
    await settle();
    const { redisDegraded } = await import("../src/core/degraded.js");
    expect(redisDegraded()).toBe(false);
    const n = f.billed.n;
    recordToolCall(call(), T0 + 1000);
    await vi.advanceTimersByTimeAsync(30_000); // still inside the 60 s back-off
    await settle();
    expect(f.billed.n).toBe(n);
    f.state.failWith = undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(f.hashes.get(statsKeys(DAY).c)?.get("flush_fail")).toBe(1);
    expect(f.hashes.get(statsKeys(DAY).c)?.get("calls:search_company")).toBe(1); // first batch dropped
  });

  it("a hanging Redis does not block the request path (timeout, fire-and-forget)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const t = Date.now();
    recordToolCall(call(), T0);
    expect(Date.now() - t).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(statsPending().inFlight).toBe(false);
  });

  it("while degraded: 0 commands; activations counted and written after recovery", async () => {
    markRedisDegraded(new Error("max requests limit exceeded"));
    recordToolCall(call(), T0);
    await settle();
    expect(f.billed.n).toBe(0);
    expect(statsPending().fields).toBeGreaterThan(0);
    clearRedisDegraded();
    recordToolCall(call(), T0 + 1);
    await settle();
    expect(f.hashes.get(statsKeys(DAY).c)?.get("degraded")).toBe(1);
    expect(f.hashes.get(statsKeys(DAY).c)?.get("calls:search_company")).toBe(2);
  });

  it("NOSCRIPT falls back to EVAL", async () => {
    f.state.noscript = true;
    recordToolCall(call(), T0);
    await settle();
    expect(f.hashes.get(statsKeys(DAY).c)?.get("calls:search_company")).toBe(1);
  });

  it("flushStats without Redis configured drops pending data and costs nothing", async () => {
    resetConfig(loadConfig({ SEC_USER_AGENT: "T t@example.org" }));
    recordToolCall(call(), T0);
    await flushStats(T0);
    expect(statsPending().days).toBe(0);
    expect(f.billed.n).toBe(0);
  });
});

describe("GET /stats", () => {
  async function seed() {
    recordToolCall(call({ ms: 40 }), T0);
    recordToolCall(call({ ms: 40, principal: ipPrincipal("203.0.113.8") }), T0);
    recordToolCall(call({ ms: 3000, ok: false, errorCode: "UPSTREAM_ERROR" }), T0);
    recordInitialize(ipPrincipal("203.0.113.7"), { name: "cursor", version: "1.0" }, T0);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
  }

  it("is disabled (404) when STATS_SECRET is unset or too short, 401 on a wrong or missing secret", async () => {
    expect((await statsResponse(statsReq(), { ...ENV, STATS_SECRET: "" } as NodeJS.ProcessEnv)).status).toBe(404);
    expect((await statsResponse(statsReq("", "short"), { ...ENV, STATS_SECRET: "short" } as NodeJS.ProcessEnv)).status).toBe(404);
    const wrong = await statsResponse(statsReq("", SECRET + "x"), ENV as NodeJS.ProcessEnv);
    expect(wrong.status).toBe(401);
    const body = (await wrong.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
    expect(body.totals).toBeUndefined();
    expect((await statsResponse(statsReq("", null), ENV as NodeJS.ProcessEnv)).status).toBe(401);
    expect(f.billed.n).toBe(0); // refused requests never touch Redis
  });

  it("validates days (1..30, default 7)", async () => {
    for (const q of ["?days=0", "?days=31", "?days=abc", "?days=1.5"]) expect((await statsResponse(statsReq(q), ENV as NodeJS.ProcessEnv)).status).toBe(400);
    const res = await statsResponse(statsReq(), ENV as NodeJS.ProcessEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { days: unknown[] }).days).toHaveLength(7);
  });

  it("returns per-day aggregates and totals with approximate counts only", async () => {
    await seed();
    const res = await statsResponse(statsReq("?days=2"), ENV as NodeJS.ProcessEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as { days: Record<string, unknown>[]; totals: Record<string, unknown> };
    expect(j.days).toHaveLength(2);
    expect(j.days[0]).toMatchObject({
      date: DAY,
      calls: 3,
      ok: 2,
      errors: 1,
      tools: { search_company: { calls: 3, ok: 2, errors: 1 } },
      error_codes: { UPSTREAM_ERROR: 1 },
      sessions: 1,
      unique_clients_approx: 2,
      clients: [{ client: "cursor/1.0", sessions: 1 }],
      latency_ms: { p50: "<=50", p95: "<=5000" },
    });
    expect(j.days[1]).toMatchObject({ calls: 0, unique_clients_approx: 0 });
    expect(j.totals).toMatchObject({ calls: 3, sessions: 1, unique_client_days_approx: 2 });
    const text = JSON.stringify(j);
    expect(text).not.toMatch(/203\.0\.113|ip:|key:/);
    for (const m of f.hlls.get(statsKeys(DAY).u)!) expect(text).not.toContain(m);
  });

  it("reading 30 days is one script call", async () => {
    const r = new Redis({ url: FAKE, token: "t", automaticDeserialization: false, enableAutoPipelining: false });
    const n = f.commands.length;
    const out = await readStats(r, 30, T0);
    expect(out.days).toHaveLength(30);
    expect(f.commands.length - n).toBe(1);
  });
});

describe("helpers", () => {
  it("latency buckets and percentiles", () => {
    expect(latencyBucket(0)).toBe("50");
    expect(latencyBucket(50)).toBe("50");
    expect(latencyBucket(51)).toBe("100");
    expect(latencyBucket(99_999)).toBe("inf");
    expect(bucketPercentile({}, 0.5)).toBeUndefined();
    expect(bucketPercentile({ "50": 9, inf: 1 }, 0.5)).toBe("<=50");
    expect(bucketPercentile({ "50": 9, inf: 1 }, 0.95)).toBe(">25000");
  });
});

describe("HTTP handler integration", () => {
  it("initialize and tools/call through the handler are aggregated", async () => {
    setCache(new MemoryCache(), new MemoryCache());
    const tickers = JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"]] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => (String(u).startsWith(FAKE) ? f.fetchStub(u, i) : new Response(tickers, { headers: { "content-type": "application/json" } }))),
    );
    const h = createHttpHandler({ quotaStore: new MemoryQuotaStore() });
    const post = (body: unknown) =>
      h(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": "198.51.100.9" },
          body: JSON.stringify(body),
        }),
      ).then((r) => r.text());
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "9.9" } } });
    await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_company", arguments: { query: "AAPL" } } });
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    const hsh = f.hashes.get(statsKeys(DAY).c)!;
    expect(hsh.get("init")).toBe(1);
    expect(hsh.get("calls:search_company")).toBe(1);
    expect(f.zsets.get(statsKeys(DAY).cl)?.get("test-client/9.9")).toBe(1);
    expect(f.hlls.get(statsKeys(DAY).u)?.size).toBe(1); // same principal for both requests
  });
});

describe("docs", () => {
  it("privacy policy and README describe the stats", () => {
    const privacy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
    expect(privacy).toMatch(/90 days/);
    expect(privacy).toMatch(/aggregate/i);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/STATS_SECRET/);
    expect(readme).toMatch(/STATS_ENABLED/);
  });
});
