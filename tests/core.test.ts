import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache, TieredCache, setCache, cached } from "../src/core/cache.js";
import { RateLimiter } from "../src/core/rateLimiter.js";
import { fetchRaw, assertSecUrl, resetLimiters } from "../src/core/http.js";
import { loadConfig, resetConfig } from "../src/config.js";
import { normalizePeriod } from "../src/sec/xbrl.js";
import { selectConceptFacts } from "../src/sec/xbrl.js";
import { matchesFilter } from "../src/sec/submissions.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

describe("cache", () => {
  it("memory cache honours TTL", async () => {
    const c = new MemoryCache(1024 * 1024);
    await c.set("k", "v", 1);
    expect(await c.get("k")).toBe("v");
  });
  it("tiered cache fills L1 from L2", async () => {
    const l1 = new MemoryCache();
    const l2 = new MemoryCache();
    await l2.set("k", "v", 60);
    const t = new TieredCache(l1, l2);
    expect(await t.get("k")).toBe("v");
    expect(await l1.get("k")).toBe("v");
  });
  it("cached() computes once", async () => {
    setCache(new MemoryCache());
    const fn = vi.fn(async () => ({ a: 1 }));
    expect(await cached("x", 60, fn)).toEqual({ a: 1 });
    expect(await cached("x", 60, fn)).toEqual({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("rate limiter", () => {
  it("spaces calls to <= rps", async () => {
    const rl = new RateLimiter(20);
    const t0 = Date.now();
    for (let i = 0; i < 11; i++) await rl.acquire();
    // 11 calls at 20/s need >= 500ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(480);
  });
});

describe("http", () => {
  it("sends the SEC User-Agent and retries on 503", async () => {
    resetConfig({ ...loadConfig({ SEC_USER_AGENT: "Test Co test@example.com" }), secMaxRps: 9 });
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push(init);
        return calls.length === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } }) : new Response("ok", { status: 200 });
      }),
    );
    expect(await fetchRaw("https://data.sec.gov/x.json", "sec")).toBe("ok");
    expect(calls).toHaveLength(2);
    expect((calls[0]!.headers as Record<string, string>)["User-Agent"]).toBe("Test Co test@example.com");
  });
  it("rejects non-SEC hosts for SEC fetches", () => {
    expect(() => assertSecUrl("https://evil.example.com/a")).toThrow(/Only https/);
    expect(() => assertSecUrl("http://www.sec.gov/a")).toThrow();
    expect(assertSecUrl("https://www.sec.gov/Archives/x").hostname).toBe("www.sec.gov");
    expect(assertSecUrl("https://www.sec.gov/Archives/x?bust=1#f").toString()).toBe("https://www.sec.gov/Archives/x");
    expect(() => assertSecUrl("https://efts.sec.gov/LATEST/search-index?q=x")).toThrow();
  });
  it("config defaults", () => {
    const c = loadConfig({});
    expect(c.secMaxRps).toBe(6);
    expect(c.secUserAgentIsDefault).toBe(true);
    expect(c.secUserAgentValid).toBe(false);
    expect(loadConfig({ SEC_MAX_RPS: "50" }).secMaxRps).toBe(8);
    expect(loadConfig({ MCP_API_KEYS: "a, b" }).apiKeys).toEqual(["a", "b"]);
  });
});

describe("xbrl helpers", () => {
  it("normalizes frame periods", () => {
    expect(normalizePeriod("2023")).toBe("CY2023");
    expect(normalizePeriod("cy2023q4i")).toBe("CY2023Q4I");
    expect(normalizePeriod("2024Q2")).toBe("CY2024Q2");
    expect(() => normalizePeriod("FY23")).toThrow();
  });
  it("selects and dedupes concept facts", () => {
    const units = {
      USD: [
        { start: "2023-01-01", end: "2023-12-31", val: 1, accn: "a", form: "10-K", filed: "2024-02-01", frame: "CY2023" },
        { start: "2023-01-01", end: "2023-12-31", val: 2, accn: "b", form: "10-K", filed: "2025-02-01" },
        { start: "2024-01-01", end: "2024-03-31", val: 3, accn: "c", form: "10-Q", filed: "2024-05-01", frame: "CY2024Q1" },
      ],
    };
    const all = selectConceptFacts(units, { framedOnly: false, limit: 10 });
    expect(all.facts.map((f) => f.val)).toEqual([3, 2]);
    const framed = selectConceptFacts(units, { framedOnly: true, limit: 10, forms: ["10-K"] });
    expect(framed.facts.map((f) => f.val)).toEqual([1]);
  });
});

describe("filing filters", () => {
  const f = { form: "10-K/A", accession: "x", filed: "2024-01-05", index_url: "" };
  it("includes amendments by default", () => {
    expect(matchesFilter(f, { forms: ["10-K"] })).toBe(true);
    expect(matchesFilter(f, { forms: ["10-K"], includeAmendments: false })).toBe(false);
    expect(matchesFilter(f, { dateFrom: "2024-02-01" })).toBe(false);
  });
});

describe("patched Node.js detection (2026-10-21 security release)", () => {
  it("accepts only patched 22/24/26 releases", async () => {
    const { isPatchedNode } = await import("../src/core/nodeVersion.js");
    for (const v of ["22.23.4", "22.24.0", "24.22.1", "v24.23.0", "26.12.1", "27.0.0"]) expect(isPatchedNode(v)).toBe(true);
    for (const v of ["20.19.2", "20.99.0", "22.23.3", "22.9.9", "24.22.0", "24.9.9", "25.9.0", "26.12.0"]) expect(isPatchedNode(v)).toBe(false);
  });
});
