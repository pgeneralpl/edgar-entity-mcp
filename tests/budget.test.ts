/**
 * B1: Upstash free-plan budget. Counts the Redis REST commands each kind of call costs, and checks
 * that plan exhaustion / Redis outages degrade to local limits instead of a global outage.
 */
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryQuotaStore, UpstashQuotaStore, chargeQuota, setQuotaStore, type Principal } from "../src/core/quota.js";
import { clearApiKeyMemo, clearSaltMemo, deleteApiKey, generateApiKey, ipPrincipal, MAX_KEY_FAILURES, storeApiKey, verifyApiKey } from "../src/core/apiKeys.js";
import { redisDegraded } from "../src/core/degraded.js";
import { createHttpHandler } from "../src/http/handler.js";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";

const SALT = "budget-test-secret-0123456789abcdefghij";
let f: ReturnType<typeof fakeUpstash>;
let redis: Redis;
const counts: Record<string, number> = {};
async function measure(label: string, fn: () => Promise<unknown>): Promise<number> {
  const before = f.commands.length;
  await fn().catch(() => undefined);
  const n = f.commands.length - before;
  counts[label] = n;
  return n;
}

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "T t@example.org", IP_HASH_SALT: SALT, UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t" }));
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
  resetConfig(undefined);
  clearApiKeyMemo();
});

describe("Redis commands per call", () => {
  it("allowed = 1, first blocked = 1, repeat blocked = 0 (day block memoised until UTC midnight)", async () => {
    const store = new UpstashQuotaStore(redis);
    const p: Principal = { id: "key:abcdefghijkl", tier: "key", perDay: 3, perMinute: 100 };
    expect(await measure("allowed quota check", () => chargeQuota(p, "search_company", {}, store))).toBe(1);
    await chargeQuota(p, "search_company", {}, store);
    await chargeQuota(p, "search_company", {}, store);
    await expect(chargeQuota(p, "search_company", {}, store)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(f.commands.length).toBe(4);
    expect(await measure("repeat blocked (day)", () => chargeQuota(p, "search_company", {}, store))).toBe(0);
    expect(await measure("repeat blocked, other tool", () => chargeQuota(p, "get_insider_trades", { limit: 20 }, store))).toBe(0);
  });
  it("anonymous allowed call = 1 command for all 4 counters (ip day, /24 day, global anon day, minute)", async () => {
    const store = new UpstashQuotaStore(redis);
    expect(await measure("anonymous allowed (4 counters)", () => chargeQuota(ipPrincipal("203.0.113.5"), "get_company_profile", {}, store))).toBe(1);
    const ev = f.commands.at(-1)!;
    expect(String(ev[0]).toLowerCase()).toBe("evalsha");
    expect(Number(ev[2])).toBe(4);
    expect(f.commands.some((c) => /hincrby/i.test(String(c[0])))).toBe(false); // no per-tool usage hashes
  });
  it("global anonymous cap: once exhausted, every anonymous caller is refused at 0 commands", async () => {
    resetConfig(loadConfig({ SEC_USER_AGENT: "T t@example.org", IP_HASH_SALT: SALT, UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t", QUOTA_ANON_GLOBAL_PER_DAY: "2" }));
    const store = new UpstashQuotaStore(redis);
    await chargeQuota(ipPrincipal("203.0.113.5"), "search_company", {}, store);
    await chargeQuota(ipPrincipal("198.51.100.7"), "search_company", {}, store);
    await expect(chargeQuota(ipPrincipal("192.0.2.9"), "search_company", {}, store)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { scope: "global" } });
    expect(await measure("repeat blocked (global anon cap, new IP)", () => chargeQuota(ipPrincipal("192.0.2.200"), "search_company", {}, store))).toBe(0);
    // API-key callers are not affected by the anonymous cap.
    await expect(chargeQuota({ id: "key:abcdefghijkl", tier: "key" }, "search_company", {}, store)).resolves.toBeUndefined();
  });
  it("forged / random keys cost 0 commands; MAC-valid unknown key costs 1, then 0", async () => {
    expect(await measure("random eem_ key", () => verifyApiKey("eem_" + "x".repeat(30)))).toBe(0);
    expect(await measure("forged key (bad MAC)", () => verifyApiKey(`eem_AAAAAAAAAAAA_${"0".repeat(24)}`))).toBe(0);
    const { key } = generateApiKey();
    expect(await measure("MAC-valid unknown key, first", () => verifyApiKey(key))).toBe(1);
    expect(await verifyApiKey(key)).toBeNull();
    expect(await measure("MAC-valid unknown key, repeat", () => verifyApiKey(key))).toBe(0);
  });
  it("valid stored key: 1 GET, then memoised; deletion removes the record and its counters", async () => {
    const { key, id } = generateApiKey();
    await storeApiKey(redis, id, { created: "2026-10-20", per_day: 50 });
    const raw = JSON.stringify([...f.kv.entries()]);
    expect(raw).not.toMatch(/name/i); // no owner name collected
    expect(await measure("valid key, first", () => verifyApiKey(key))).toBe(1);
    expect(await measure("valid key, repeat", () => verifyApiKey(key))).toBe(0);
    const store = new UpstashQuotaStore(redis);
    await chargeQuota((await verifyApiKey(key))!, "search_company", {}, store);
    expect([...f.kv.keys()].some((k) => k.includes(`key:${id}:`))).toBe(true);
    const r = await deleteApiKey(redis, key);
    expect(r.record).toBe(true);
    expect(r.counters).toBe(2);
    expect([...f.kv.keys()].filter((k) => k.includes(id))).toEqual([]);
  });
  it("HTTP: bad keys → 401 without Redis, then 429 after repeated failures (0 commands)", async () => {
    const h = createHttpHandler({ quotaStore: new MemoryQuotaStore() });
    const call = (k: string) =>
      h(new Request("https://x/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${k}`, "x-real-ip": "203.0.113.50" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const before = f.commands.length;
    for (let i = 0; i < MAX_KEY_FAILURES; i++) expect((await call(`eem_AAAAAAAAAAA${i % 10}_${"0".repeat(24)}`)).status).toBe(401);
    const blocked = await call(`eem_BBBBBBBBBBBB_${"0".repeat(24)}`);
    expect(blocked.status).toBe(429);
    expect(f.commands.length - before).toBe(0);
  });
});

describe("degraded mode", () => {
  it("Upstash plan limit → local in-memory limits instead of an outage, then 0 commands during cool-down", async () => {
    const store = new UpstashQuotaStore(redis);
    f.state.failWith = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000.";
    const p = ipPrincipal("203.0.113.5");
    await expect(chargeQuota(p, "search_company", {}, store)).resolves.toBeUndefined();
    expect(redisDegraded()).toBe(true);
    expect(await measure("degraded call", () => chargeQuota(p, "search_company", {}, store))).toBe(0);
    // Local limits still apply (anonymous per-minute default).
    let refused = false;
    for (let i = 0; i < 100 && !refused; i++) await chargeQuota(p, "search_company", {}, store).catch(() => (refused = true));
    expect(refused).toBe(true);
    // MAC-valid keys keep working (unverified, default key limits) without Redis.
    const { key } = generateApiKey();
    expect(await verifyApiKey(key)).toMatchObject({ tier: "key", unverified: true });
  });
  it("reports the measured command counts", () => {
    // Printed for the PR description / report.
    if (process.env.BUDGET_REPORT) writeFileSync(process.env.BUDGET_REPORT, JSON.stringify(counts, null, 1));
    expect(Object.keys(counts).length).toBeGreaterThan(5);
  });
});
