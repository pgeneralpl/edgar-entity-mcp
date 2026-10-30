import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGHER_LIMITS_ISSUE_URL, higherLimitsHint, loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { fetchRaw, resetLimiters } from "../src/core/http.js";
import { MemoryQuotaStore, rateLimitedError, setQuotaStore, type Principal } from "../src/core/quota.js";
import { clearApiKeyMemo, ipPrincipal, MAX_KEY_FAILURES } from "../src/core/apiKeys.js";
import { clearRedisDegraded, markRedisDegraded } from "../src/core/degraded.js";
import { runWithContext } from "../src/core/context.js";
import { ToolError } from "../src/core/errors.js";
import { createHttpHandler } from "../src/http/handler.js";

const UA = "Test Co test@example.org";
const cfg = (env: Record<string, string> = {}) => resetConfig(loadConfig({ SEC_USER_AGENT: UA, ...env }));
const HDR = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const post = (h: (r: Request) => Promise<Response>, headers: Record<string, string> = {}) =>
  h(new Request("https://edgar.test/mcp", { method: "POST", headers: { ...HDR, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
type RpcErr = { error: { code: number; message: string; data?: { hint?: string } } };

beforeEach(() => {
  cfg();
  setCache(new MemoryCache(), new MemoryCache());
});
afterEach(() => {
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
  setQuotaStore(undefined);
  clearApiKeyMemo();
  clearRedisDegraded();
});

describe("limit hints point at the higher-limits issue form", () => {
  it("is a single constant pointing at the issue template", () => {
    expect(HIGHER_LIMITS_ISSUE_URL).toBe("https://github.com/pgeneralpl/edgar-entity-mcp/issues/new?template=higher-limits.yml");
    expect(loadConfig({}).keyRequestUrl).toBe(HIGHER_LIMITS_ISSUE_URL);
    expect(higherLimitsHint()).toBe(
      `Higher limits on the hosted endpoint may be requested by a person at ${HIGHER_LIMITS_ISSUE_URL} (requests are reviewed manually and may be declined; please do not file automatically).`,
    );
  });

  it("accepts only an https KEY_REQUEST_URL override, otherwise falls back to the constant with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig({ KEY_REQUEST_URL: "https://example.org/limits" }).keyRequestUrl).toBe("https://example.org/limits");
      expect(loadConfig({ KEY_REQUEST_URL: "  " }).keyRequestUrl).toBe(HIGHER_LIMITS_ISSUE_URL);
      expect(warn).not.toHaveBeenCalled();
      for (const bad of ["http://example.org/limits", "javascript:alert(1)", "not a url", "/relative/path", "ftp://example.org/x"]) {
        expect(loadConfig({ KEY_REQUEST_URL: bad }).keyRequestUrl).toBe(HIGHER_LIMITS_ISSUE_URL);
      }
      expect(warn).toHaveBeenCalledTimes(5);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/KEY_REQUEST_URL/);
    } finally {
      warn.mockRestore();
    }
  });

  it("RATE_LIMITED quota errors (anonymous minute/day, network, global, API key) carry the issue URL, codes and details unchanged", () => {
    const anon = ipPrincipal("203.0.113.9");
    const key: Principal = { id: "key:abc", tier: "key" };
    const cases: [Principal, "minute" | "day" | "network" | "global"][] = [
      [anon, "minute"], [anon, "day"], [anon, "network"], [anon, "global"], [key, "minute"], [key, "day"],
    ];
    for (const [p, scope] of cases) {
      const e = rateLimitedError(p, { ok: false, scope, limit: 10, remaining: 0, retryAfterSeconds: 30 }, 2);
      expect(e.code).toBe("RATE_LIMITED");
      expect(e.hint).toContain(higherLimitsHint());
      expect(e.hint).toContain(HIGHER_LIMITS_ISSUE_URL);
      expect(e.hint).not.toMatch(/free (API )?key|request a key|API key at/i);
      expect(e.details).toMatchObject({ retry_after_seconds: 30, scope, limit: 10, cost: 2 });
    }
  });

  it("degraded-mode RATE_LIMITED does not carry the higher-limits hint", async () => {
    cfg({ UPSTASH_REDIS_REST_URL: "https://fake-upstash.test", UPSTASH_REDIS_REST_TOKEN: "t", IP_HASH_SALT: "s".repeat(40), API_KEY_SECRET: "k".repeat(40) });
    markRedisDegraded(new Error("max requests limit exceeded"));
    const e = await runWithContext({ transport: "http", principal: ipPrincipal("203.0.113.9") }, () =>
      fetchRaw("https://data.colorado.gov/resource/x.json", "socrata"),
    ).catch((x) => x as ToolError);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe("RATE_LIMITED");
    expect((e as ToolError).details).toMatchObject({ scope: "degraded", retry_after_seconds: 120 });
    expect((e as ToolError).hint).toBe("Retry in a few minutes, or run the server locally from source (https://github.com/pgeneralpl/edgar-entity-mcp).");
    expect((e as ToolError).hint).not.toContain(HIGHER_LIMITS_ISSUE_URL);
  });

  it("401 invalid key keeps 'Invalid API key.' and hints at the issue form", async () => {
    const h = createHttpHandler({ quotaStore: new MemoryQuotaStore(), verifyKey: async () => null });
    const res = await post(h, { authorization: "Bearer eem_bad", "x-forwarded-for": "198.51.100.7" });
    expect(res.status).toBe(401);
    const b = (await res.json()) as RpcErr;
    expect(b.error.code).toBe(-32001);
    expect(b.error.message).toBe("Invalid API key.");
    expect(b.error.data?.hint).toBe(`Check the key, or omit it to use the anonymous tier. ${higherLimitsHint()}`);
  });

  it("401 key required (MCP_REQUIRE_API_KEY=1) says a person may request a key at the issue form", async () => {
    cfg({ MCP_REQUIRE_API_KEY: "1" });
    const res = await post(createHttpHandler({ quotaStore: new MemoryQuotaStore() }));
    expect(res.status).toBe(401);
    const b = (await res.json()) as RpcErr;
    expect(b.error.message).toBe("An API key is required.");
    expect(b.error.data?.hint).toBe(`An API key is required on this server. A person may request one at ${HIGHER_LIMITS_ISSUE_URL}.`);
  });

  it("HTTP 429 after too many invalid keys only says to check the key (no issue link)", async () => {
    const h = createHttpHandler({ quotaStore: new MemoryQuotaStore(), verifyKey: async () => null });
    const hdr = { authorization: "Bearer eem_bad", "x-forwarded-for": "198.51.100.8" };
    for (let i = 0; i < MAX_KEY_FAILURES; i++) expect((await post(h, hdr)).status).toBe(401);
    const res = await post(h, hdr);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    const b = (await res.json()) as RpcErr;
    expect(b.error.code).toBe(-32001);
    expect(b.error.data?.hint).toBe("Check your API key.");
  });
});
