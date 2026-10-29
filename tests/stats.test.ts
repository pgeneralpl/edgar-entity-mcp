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
  STATS_RETENTION_DAYS,
  STATS_CLIENT_LABELS,
  dayEndMs,
  saltTtlSeconds,
  statsExpireAt,
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
    // Absolute expiry: end of the UTC day + 30 days (EXPIREAT, so every write leaves a TTL).
    expect(f.expireAts.get(k.c)).toBe(statsExpireAt(DAY));
    expect(f.expireAts.get(k.u)).toBe(statsExpireAt(DAY));
    expect(statsExpireAt(DAY)).toBe(Date.UTC(2026, 9, 30) / 1000 + STATS_RETENTION_DAYS * 86400);
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
    expect(salt!.ttl!).toBe(13 * 3600); // T0 is 12:00 UTC: 12 h to the end of the day + 1 h
    for (const m of f.hlls.get(statsKeys(DAY).u)!) expect(m).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records a client label only after the principal's first successful call, once per principal per day", async () => {
    const p = ipPrincipal("203.0.113.7");
    recordInitialize(p, { name: "Cursor", version: "1.7.2" }, T0);
    await settle();
    expect(f.hashes.get(statsKeys(DAY).c)?.get("init")).toBe(1);
    expect(f.zsets.get(statsKeys(DAY).cl)).toBeUndefined(); // initialize alone records no label
    recordToolCall(call({ principal: p, ok: false, errorCode: "NOT_FOUND" }), T0 + 1);
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(f.zsets.get(statsKeys(DAY).cl)).toBeUndefined(); // nor does a failed call
    for (let i = 0; i < 5; i++) {
      recordInitialize(p, { name: "Cursor", version: "1.7.2" }, Date.now());
      recordToolCall(call({ principal: p }), Date.now());
    }
    recordToolCall(call({ principal: ipPrincipal("203.0.113.99") }), Date.now()); // no initialize seen: no label
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(Object.fromEntries(f.zsets.get(statsKeys(DAY).cl)!)).toEqual({ "cursor/1": 1 });
    // Next UTC day: the same principal counts again (once).
    const next = T0 + 86400_000;
    vi.setSystemTime(next);
    recordToolCall(call({ principal: p }), next);
    recordToolCall(call({ principal: p }), next + 1);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(Object.fromEntries(f.zsets.get(statsKeys(isoDay(next)).cl)!)).toEqual({ "cursor/1": 1 });
  });

  it("clientInfo poisoning: free text never reaches Redis, unknown names become 'other' and cannot inflate counts", async () => {
    const evil = [
      "john.doe@example.com",
      "Cursor <script>alert(1)</script>",
      "cursor evil payload",
      "Claude\u0000Desktop; DROP TABLE",
      "x".repeat(10_000),
      "Ｃｕｒｓｏｒ-tracking-id-123456",
      "visit https://spam.example",
    ];
    evil.forEach((name, i) => {
      const p = ipPrincipal(`198.51.100.${i + 1}`);
      recordInitialize(p, { name, version: `${i}.0; ${name}` }, T0);
      for (let j = 0; j < 20; j++) recordToolCall(call({ principal: p }), T0 + j); // repeat calls: counted once
    });
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(Object.fromEntries(f.zsets.get(statsKeys(DAY).cl)!)).toEqual({ other: evil.length });
    const dump = JSON.stringify(f.commands);
    for (const s of ["john.doe", "example.com", "script", "evil", "DROP", "xxxxxxxxxx", "tracking", "spam"]) expect(dump).not.toContain(s);
    // Every label that can be written comes from the fixed allowlist.
    for (const k of f.zsets.get(statsKeys(DAY).cl)!.keys()) expect(STATS_CLIENT_LABELS).toContain(k.split("/")[0]);
  });

  it("normalizeClient: allowlisted labels with the major version only, everything else 'other'", () => {
    const cases: [unknown, string][] = [
      [{ name: "claude-ai", version: "0.1.0" }, "claude/0"],
      [{ name: "Claude Desktop", version: "1.2.3" }, "claude/1"],
      [{ name: "claude-code", version: "2.0.14" }, "claude-code/2"],
      [{ name: "cursor-vscode", version: "1.0.0" }, "cursor/1"],
      [{ name: "Visual Studio Code - Insiders", version: "1.105.0-insider" }, "vscode/1"],
      [{ name: "GitHub Copilot" }, "vscode"],
      [{ name: "mcp-inspector", version: "0.17.0" }, "mcp-inspector/0"],
      [{ name: "Windsurf" }, "windsurf"],
      [{ name: "Zed", version: "v0.200.1" }, "zed/0"],
      [{ name: "continue-client" }, "continue"],
      [{ name: "Cline", version: "3" }, "cline/3"],
      [{ name: "goose" }, "goose"],
      [{ name: "openai-mcp", version: "1.0.0" }, "openai/1"],
      [{ name: "ChatGPT" }, "openai"],
      [{ name: "gemini-cli-mcp-client", version: "0.1.0" }, "gemini/0"],
      [{ name: "@librechat/api-client" }, "librechat"],
      [{ name: "n8n-mcp-client" }, "n8n"],
      [{ name: "mcp-remote", version: "0.1.29" }, "mcp-remote/0"],
      [{ name: "cursor", version: "1.2; DROP" }, "cursor/1"],
      [{ name: "cursor", version: "abc" }, "cursor"],
      [{ name: "cursor", version: "123456" }, "cursor"],
      [{ name: "john.doe@example.com", version: "1" }, "other"],
      [{ name: "cursor evil" }, "other"],
      [{ name: 42 }, "other"],
      [{}, "other"],
      [null, "other"],
    ];
    for (const [info, want] of cases) expect(normalizeClient(info), JSON.stringify(info)).toBe(want);
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
    recordInitialize(ipPrincipal("203.0.113.7"), { name: "evil-client-name" }, T0);
    for (let i = 0; i < 100; i++) recordToolCall(call({ tool: `Bad Tool ${i}`, ok: i > 0, errorCode: `CODE_${i}` }), T0);
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

describe("daily salt lifecycle (B2)", () => {
  it("salt TTL is end(D) + 1 h − now", () => {
    expect(saltTtlSeconds(DAY, T0)).toBe(13 * 3600);
    expect(saltTtlSeconds(DAY, dayEndMs(DAY) - 1000)).toBe(3601);
    expect(saltTtlSeconds(DAY, dayEndMs(DAY) + 1800_000)).toBe(1800);
    expect(saltTtlSeconds(DAY, dayEndMs(DAY) + 3600_000)).toBe(0);
    expect(saltTtlSeconds(DAY, dayEndMs(DAY) + 7200_000)).toBeLessThan(0);
  });

  it("a salt created just after midnight for the previous day lives only until 01:00 UTC", async () => {
    const end = dayEndMs(DAY);
    vi.setSystemTime(end - 10_000);
    f.state.failWith = "ERR down"; // first flush fails, so day D stays pending past midnight
    recordToolCall(call(), end - 10_000);
    await settle();
    f.state.failWith = undefined;
    recordToolCall(call({ principal: ipPrincipal("203.0.113.8") }), end - 5_000);
    vi.setSystemTime(end + 1800_000);
    await flushStats(end + 1800_000); // 00:30 UTC next day
    expect(f.kv.get(statsKeys(DAY).salt)?.ttl).toBe(1800);
    expect(f.hlls.get(statsKeys(DAY).u)?.size).toBe(1);
  });

  it("after end(D) + 1 h no salt is created or used and no HLL member is written for D; counters still are", async () => {
    const end = dayEndMs(DAY);
    vi.setSystemTime(end - 10_000);
    f.state.failWith = "ERR down";
    recordToolCall(call(), end - 10_000);
    await settle();
    f.state.failWith = undefined;
    recordToolCall(call({ principal: ipPrincipal("203.0.113.8") }), end - 5_000);
    vi.setSystemTime(end + 3601_000);
    const n = f.commands.length;
    await flushStats(end + 3601_000);
    expect(f.kv.has(statsKeys(DAY).salt)).toBe(false);
    expect(f.hlls.has(statsKeys(DAY).u)).toBe(false);
    expect(f.commands.slice(n).some((c) => String(c[0]).toLowerCase() === "evalsha" && c.includes(statsKeys(DAY).salt))).toBe(false);
    expect(f.hashes.get(statsKeys(DAY).c)?.get("calls:search_company")).toBe(1);
    expect(f.hashes.get(statsKeys(DAY).c)?.get("flush_fail")).toBe(1);
  });

  it("an in-memory salt is never used after end(D) + 1 h, and older salts are dropped on every flush", async () => {
    recordToolCall(call(), T0);
    await settle();
    expect(statsPending().saltDays).toEqual([DAY]);
    const end = dayEndMs(DAY);
    // Pending D data flushed after the grace: memoised salt is not used.
    vi.setSystemTime(end - 1000);
    recordToolCall(call({ principal: ipPrincipal("203.0.113.50") }), end - 1000); // trailing (within the interval)
    await flushStats(end + 3700_000);
    expect(f.hlls.get(statsKeys(DAY).u)?.size).toBe(1);
    expect(statsPending().saltDays).toEqual([]);
    // Next day: today's salt is created, yesterday's is gone from memory.
    const next = end + 4000_000;
    vi.setSystemTime(next + STATS_FLUSH_INTERVAL_MS);
    recordToolCall(call(), next + STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(statsPending().saltDays).toEqual([isoDay(next)]);
  });
});

describe("environment gating (B4)", () => {
  it("records only in Vercel production or when self-hosted; STATS_ENABLED=false always wins", () => {
    expect(loadConfig({ ...ENV, VERCEL: "1", VERCEL_ENV: "production" }).statsEnabled).toBe(true);
    expect(loadConfig({ ...ENV, VERCEL: "1", VERCEL_ENV: "preview" }).statsEnabled).toBe(false);
    expect(loadConfig({ ...ENV, VERCEL: "1", VERCEL_ENV: "development" }).statsEnabled).toBe(false);
    expect(loadConfig({ ...ENV, VERCEL: "1" }).statsEnabled).toBe(false);
    expect(loadConfig(ENV).statsEnabled).toBe(true); // self-hosted
    expect(loadConfig({ ...ENV, STATS_ENABLED: "false" }).statsEnabled).toBe(false);
    expect(loadConfig({ ...ENV, VERCEL: "1", VERCEL_ENV: "production", STATS_ENABLED: "0" }).statsEnabled).toBe(false);
  });

  it("a preview deployment sends no stats commands", async () => {
    resetStats();
    resetConfig(loadConfig({ ...ENV, VERCEL: "1", VERCEL_ENV: "preview" }));
    recordInitialize(ipPrincipal("203.0.113.7"), { name: "cursor" }, T0);
    recordToolCall(call(), T0);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    expect(statsPending().days).toBe(0);
    expect(f.billed.n).toBe(0);
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
    recordInitialize(ipPrincipal("203.0.113.7"), { name: "cursor", version: "1.0" }, T0);
    recordToolCall(call({ ms: 40 }), T0);
    recordToolCall(call({ ms: 40, principal: ipPrincipal("203.0.113.8") }), T0);
    recordToolCall(call({ ms: 3000, ok: false, errorCode: "UPSTREAM_ERROR" }), T0);
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
  }

  it("answers 404 when STATS_SECRET is unset or too short and on a wrong or missing secret (endpoint not revealed)", async () => {
    const bodies: string[] = [];
    for (const [req, env] of [
      [statsReq(), { ...ENV, STATS_SECRET: "" }],
      [statsReq("", "short"), { ...ENV, STATS_SECRET: "short" }],
      [statsReq("", SECRET + "x"), ENV],
      [statsReq("", SECRET.slice(0, -1)), ENV],
      [statsReq("", null), ENV],
    ] as [Request, NodeJS.ProcessEnv][]) {
      const res = await statsResponse(req, env);
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1); // indistinguishable
    expect(bodies[0]).not.toMatch(/secret|stats|unauthori/i);
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
      clients: [{ client: "cursor/1", principals: 1 }],
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
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Cursor", version: "1.7.2" } } });
    await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_company", arguments: { query: "AAPL" } } });
    await settle();
    await vi.advanceTimersByTimeAsync(STATS_FLUSH_INTERVAL_MS);
    await settle();
    const hsh = f.hashes.get(statsKeys(DAY).c)!;
    expect(hsh.get("init")).toBe(1);
    expect(hsh.get("calls:search_company")).toBe(1);
    expect(Object.fromEntries(f.zsets.get(statsKeys(DAY).cl)!)).toEqual({ "cursor/1": 1 });
    expect(f.hlls.get(statsKeys(DAY).u)?.size).toBe(1); // same principal for both requests
  });
});

describe("docs", () => {
  it("privacy policy and README describe the stats", () => {
    const privacy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
    expect(privacy).toMatch(/30 days/);
    expect(privacy).not.toMatch(/90 days/);
    expect(privacy).toMatch(/pseudonymous/);
    expect(privacy).toMatch(/Once the daily secret is deleted/);
    expect(privacy).toMatch(/never free-text/i);
    expect(privacy).toMatch(/aggregate/i);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/STATS_SECRET/);
    expect(readme).toMatch(/STATS_ENABLED/);
    expect(readme).not.toMatch(/90-day|90 days/);
    expect(readme).not.toMatch(/Production and Preview/);
  });
});
