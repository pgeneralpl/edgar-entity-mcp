/** XBRL URL hardening (tag/taxonomy/unit validation, no '.'/'..' path segments) and compare_companies reservation. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { toolCost } from "../src/core/quota.js";
import { compareCompanies, getXbrlConcept } from "../src/tools.js";
import { conceptUrl, frameUrl, normalizeFrameUnit, splitTag, FRAME_TAXONOMIES } from "../src/sec/xbrl.js";

const TICKERS = { fields: ["cik", "name", "ticker", "exchange"], data: [[320193, "Apple Inc.", "AAPL", "Nasdaq"], [37996, "FORD MOTOR CO", "F", "NYSE"]] };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const frame = (tag: string) => ({ taxonomy: "us-gaap", tag, ccp: "CY2015", uom: "USD", pts: 1, data: [{ accn: "a", cik: 37996, entityName: "Ford", start: "2015-01-01", end: "2015-12-31", val: 1 }] });
let urls: string[] = [];

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(href);
      const u = new URL(href);
      if (u.hostname === "www.sec.gov") return json(TICKERS);
      const fm = /\/frames\/us-gaap\/([^/]+)\//.exec(u.pathname);
      if (fm) return fm[1] === "Revenues" ? json(frame("Revenues")) : json({ message: "not found" }, 404);
      return json({ message: "not found" }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

const runCompare = (a: Record<string, unknown>) => compareCompanies.run(a as never);
const frameFetches = () => urls.filter((u) => u.includes("/frames/"));

describe("compare_companies input hardening", () => {
  it("rejects '..' tag/unit at the schema and never requests a traversed URL", async () => {
    const s = compareCompanies.inputSchema;
    expect(s.safeParse({ tag: "..:..", unit: "..", period: "CY2024" }).success).toBe(false);
    // Defense in depth: even if the schema were bypassed, run() refuses before any request.
    await expect(runCompare({ tag: "..:..", unit: "..", period: "CY2024", taxonomy: "us-gaap", order: "desc", limit: 20 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runCompare({ tag: "..", period: "CY2024", taxonomy: "us-gaap", order: "desc", limit: 20 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(urls).toEqual([]);
    expect(urls).not.toContain("https://data.sec.gov/CY2024.json");
  });
  it("rejects metric mode with an invalid unit before any request", async () => {
    const a = compareCompanies.inputSchema.parse({ metric: "revenue", unit: "..", period: "CY2024" });
    await expect(compareCompanies.run(a)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const unit of ["USD/../x", "a b", "-USD", "USD/" + "x".repeat(33), "USD%2F..", ""]) {
      await expect(compareCompanies.run(compareCompanies.inputSchema.parse({ metric: "revenue", unit, period: "CY2024" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(urls).toEqual([]);
  });
  it("checks the taxonomy prefix against the frames taxonomies", async () => {
    await expect(compareCompanies.run(compareCompanies.inputSchema.parse({ tag: "abc:Assets", period: "CY2024" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(compareCompanies.run(compareCompanies.inputSchema.parse({ tag: "invest:Assets", period: "CY2024" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(urls).toEqual([]);
  });
  it("still accepts USD/shares and normal tags", async () => {
    expect(normalizeFrameUnit("USD/shares")).toBe("USD-per-shares");
    expect(normalizeFrameUnit("pure")).toBe("pure");
    expect(splitTag("us-gaap:Revenues", "dei", FRAME_TAXONOMIES)).toEqual({ taxonomy: "us-gaap", tag: "Revenues" });
    expect(splitTag(" Revenues ", "us-gaap", FRAME_TAXONOMIES)).toEqual({ taxonomy: "us-gaap", tag: "Revenues" });
    const r = (await compareCompanies.run(compareCompanies.inputSchema.parse({ tag: "us-gaap:Revenues", unit: "USD", period: "CY2015" }))) as { results: unknown[] };
    expect(r.results).toHaveLength(1);
    expect(frameFetches()).toEqual(["https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2015.json"]);
  });
});

describe("SEC XBRL URL builders", () => {
  it("refuse '.', '..' and empty path segments", () => {
    for (const bad of [".", "..", ""]) {
      expect(() => frameUrl(bad, "Assets", "USD", "CY2024")).toThrow(/path segment/);
      expect(() => frameUrl("us-gaap", bad, "USD", "CY2024")).toThrow(/path segment/);
      expect(() => frameUrl("us-gaap", "Assets", bad, "CY2024")).toThrow(/path segment/);
      expect(() => conceptUrl("320193", bad, "Assets")).toThrow(/path segment/);
      expect(() => conceptUrl("320193", "us-gaap", bad)).toThrow(/path segment/);
    }
    expect(frameUrl("us-gaap", "Assets", "USD", "CY2024Q4I")).toBe("https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2024Q4I.json");
    expect(frameUrl("us-gaap", "A..", "USD", "CY2024")).toContain("/A../"); // dots inside a name are fine
  });
});

describe("get_xbrl_concept taxonomy prefix", () => {
  it("rejects an unknown taxonomy prefix such as abc:Assets without a request", async () => {
    const a = getXbrlConcept.inputSchema.parse({ company: "320193", tag: "abc:Assets" });
    await expect(getXbrlConcept.run(a)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/taxonomy "abc"/) });
    expect(urls.filter((u) => u.includes("companyconcept"))).toEqual([]);
  });
});

describe("compare_companies reservation", () => {
  it("covers the requests a call can make (one per frame + tickers), so settlement refunds little", async () => {
    // CY2015 revenue tries all 3 fallback tags (only Revenues exists here) plus the tickers file.
    await compareCompanies.run(compareCompanies.inputSchema.parse({ metric: "revenue", period: "CY2015", companies: ["AAPL"] }));
    expect(frameFetches()).toHaveLength(3);
    expect(urls.length).toBeLessThanOrEqual(toolCost("compare_companies", { metric: "revenue" }));
    expect(toolCost("compare_companies", { metric: "revenue" })).toBe(4);
    urls = [];
    await compareCompanies.run(compareCompanies.inputSchema.parse({ tag: "Revenues", period: "CY2015", companies: ["F"] }));
    expect(urls.length).toBeLessThanOrEqual(toolCost("compare_companies", { tag: "Revenues" }));
  });
});
