/**
 * Data minimisation of rate-limit state: Redis holds only integer counters under hashed ids,
 * with TTLs equal to the enforced window; hashes rotate daily; logs carry no IPs or arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, TieredCache, UpstashCache, cached, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { DAY_COUNTER_TTL_SECONDS, MINUTE_COUNTER_TTL_SECONDS, UpstashQuotaStore, setQuotaStore } from "../src/core/quota.js";
import { clearApiKeyMemo, clearSaltMemo, daySalt, ipPrincipal } from "../src/core/apiKeys.js";
import { HttpError, logError } from "../src/core/errors.js";
import { createHttpHandler } from "../src/http/handler.js";
import { setSystemUsageHook, setUsageHooks, stderrUsageLogger } from "../src/core/usage.js";

import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";
const RAW_IP = "203.0.113.77";
const XFF_IP = "198.51.100.23";
const SECRET_ARG = "SENSITIVEARG-Jane-Doe";
const UA_STR = "SecretAgentUA/9.9";

let stderr: string[] = [];
beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org", IP_HASH_SALT: "test-secret-0123456789abcdefghijklmnop", UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t" }));
  clearSaltMemo();
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
  setQuotaStore(undefined);
  setSystemUsageHook("quota", undefined);
  setUsageHooks({});
  clearApiKeyMemo();
});

describe("Redis rate-limit state contains no raw IPs, user agents, paths or tool arguments", () => {
  it("end to end through the HTTP handler", async () => {
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fetchStub);
    const redis = new Redis({ url: FAKE, token: "t", automaticDeserialization: false });
    setCache(new TieredCache(new MemoryCache(), new UpstashCache(redis, 900_000)), new MemoryCache());
    setUsageHooks(stderrUsageLogger); // USAGE_LOG=1 path must not leak either
    const h = createHttpHandler({ quotaStore: new UpstashQuotaStore(redis) });
    const call = (id: number) =>
      h(
        new Request("https://edgar.test/mcp?probe=pathsecret", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": RAW_IP, "x-forwarded-for": `${XFF_IP}, 10.0.0.1`, "user-agent": UA_STR },
          // Disallowed URL: charged 3 units, then rejected locally (no upstream call).
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_filing_document", arguments: { url: `https://www.sec.gov/cgi-bin/x?q=${SECRET_ARG}` } } }),
        }),
      );
    for (let i = 1; i <= 3; i++) expect((await call(i)).status).toBe(200);
    // Shared cache write with argument-bearing logical key.
    await cached(`states:CO:name like '%${SECRET_ARG}%'`, 60, async () => ({ ok: 1 }));

    const dump = JSON.stringify(f.commands) + JSON.stringify([...f.kv.entries()]) + stderr.join("");
    for (const needle of [RAW_IP, "203.0.113", XFF_IP, "198.51.100", UA_STR, "SecretAgent", SECRET_ARG, "Jane", "pathsecret", "probe", "cgi-bin"]) expect(dump).not.toContain(needle);

    const keys = [...f.kv.keys()];
    expect(keys.some((k) => /^eem:v1:q:d:ip:[0-9a-f]{20}:\d{8}$/.test(k))).toBe(true); // per-IP daily
    expect(keys.some((k) => /^eem:v1:q:d:net:[0-9a-f]{20}:\d{8}$/.test(k))).toBe(true); // per-/24 daily
    expect(keys.some((k) => /^eem:v1:q:m:ip:[0-9a-f]{20}:\d+$/.test(k))).toBe(true); // per-minute
    // Every key is a hashed id, a cache hash, or a counter; every quota value is an integer.
    for (const k of keys) expect(k).toMatch(/^eem:v1:(q:[dm]:((ip|net|key):[0-9a-f]+|anon):\d+|c:[0-9a-f]{40})$/);
    for (const [k, { v, ttl }] of f.kv) {
      if (k.includes(":q:")) expect(v).toMatch(/^\d+$/);
      if (k.includes(":q:d:")) expect(ttl).toBe(DAY_COUNTER_TTL_SECONDS);
      if (k.includes(":q:m:")) expect(ttl).toBe(MINUTE_COUNTER_TTL_SECONDS);
    }
    expect(DAY_COUNTER_TTL_SECONDS).toBe(25 * 3600);
    expect(keys.some((k) => /:u:/.test(k))).toBe(false); // no usage hashes
  });
});

describe("daily-rotating IP hash salt", () => {
  it("is HMAC(secret, UTC day): stable within a day, unlinkable across days and secrets", () => {
    const a = ipPrincipal(RAW_IP, "20261020");
    expect(ipPrincipal(RAW_IP, "20261020")).toEqual(a);
    const b = ipPrincipal(RAW_IP, "20261021");
    expect(b.id).not.toBe(a.id);
    expect(b.network).not.toBe(a.network);
    expect(a.day).toBe("20261020");
    expect(daySalt("20261020")).not.toBe(daySalt("20261021"));
    resetConfig(loadConfig({ IP_HASH_SALT: "other-secret" }));
    clearSaltMemo();
    expect(ipPrincipal(RAW_IP, "20261020").id).not.toBe(a.id);
  });
  it("counts a request against the day its hash was derived for (midnight boundary)", async () => {
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fetchStub);
    const store = new UpstashQuotaStore(new Redis({ url: FAKE, token: "t", automaticDeserialization: false }));
    const p = ipPrincipal(RAW_IP, "20261020"); // hashed at 23:59:59.999
    await store.consume(p, 1, { perMinute: 10, perDay: 10, networkPerDay: 100 });
    const dayKeys = [...f.kv.keys()].filter((k) => k.includes(":q:d:"));
    expect(dayKeys.length).toBe(2);
    expect(dayKeys.every((k) => k.endsWith(":20261020"))).toBe(true);
  });
  it("refuses to serve when Redis is on and IP_HASH_SALT is missing, default or short", async () => {
    const redis = { UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t" };
    expect(loadConfig(redis).startupProblem).toMatch(/IP_HASH_SALT/);
    expect(loadConfig({ ...redis, IP_HASH_SALT: "edgar-entity-mcp" }).startupProblem).toMatch(/IP_HASH_SALT/);
    expect(loadConfig({ ...redis, IP_HASH_SALT: "short-secret" }).startupProblem).toMatch(/32/);
    expect(loadConfig({ ...redis, IP_HASH_SALT: "x".repeat(32) }).startupProblem).toBeUndefined();
    expect(loadConfig({}).startupProblem).toBeUndefined(); // no Redis: nothing persisted
    resetConfig(loadConfig({ ...redis, SEC_USER_AGENT: "T t@example.org" }));
    const res = await createHttpHandler()(new Request("https://x/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(503);
  });
});

describe("logs carry no IPs, emails or query strings", () => {
  it("redacts upstream URLs' queries, IPs and emails in error logs", () => {
    logError("t", new HttpError(500, `https://data.colorado.gov/resource/4ykn-tg5h.json?$where=entityname like '%${SECRET_ARG}%'`, `boom from ${RAW_IP} and 2001:db8::1 for jane@example.org`));
    logError("t", new Error(`fetch https://www.sec.gov/cgi-bin/browse?company=${SECRET_ARG}#x failed for ${XFF_IP}`));
    const out = stderr.join("");
    expect(out).toContain("[ip]");
    for (const needle of [SECRET_ARG, RAW_IP, XFF_IP, "2001:db8::1", "jane@example.org", "entityname"]) expect(out).not.toContain(needle);
  });
});

describe("quota backend timeout", () => {
  it("fails closed when the store hangs", async () => {
    vi.useFakeTimers();
    const { chargeQuota, QUOTA_TIMEOUT_MS } = await import("../src/core/quota.js");
    const p = chargeQuota(ipPrincipal(RAW_IP), "search_company", {}, { consume: () => new Promise(() => {}) }).catch((e: { code?: string }) => e.code);
    await vi.advanceTimersByTimeAsync(QUOTA_TIMEOUT_MS + 10);
    expect(await p).toBe("RATE_LIMITED");
    vi.useRealTimers();
  });
});
