/** compare_companies metric aliases, fiscal/calendar labelling, get_financials hints, get_xbrl_concept fallback (fetch stubbed). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { toolCost } from "../src/core/quota.js";
import { ToolError } from "../src/core/errors.js";
import { compareCompanies, getFinancialsTool, getXbrlConcept } from "../src/tools.js";
import { computeFinancials } from "../src/sec/financials.js";
import { calendarPeriodEnd, durationOf, selectConceptFacts } from "../src/sec/xbrl.js";
import { canonicalMetric, frameTagsFor, FRAME_METRIC_INPUTS, MAX_FRAME_TAGS, FRAME_METRICS } from "../src/sec/metricAliases.js";
import type { CompanyFacts, Fact } from "../src/sec/xbrlTypes.js";

const cf = JSON.parse(readFileSync(new URL("./fixtures/companyfacts-aapl-trimmed.json", import.meta.url), "utf8")) as CompanyFacts;

const TICKERS = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1018724, "AMAZON COM INC", "AMZN", "Nasdaq"],
    [37996, "FORD MOTOR CO", "F", "NYSE"],
  ],
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const row = (cik: number, entityName: string, val: number, start: string, end: string) => ({ accn: `000${cik}-25-000001`, cik, entityName, start, end, val, loc: "US-WA" });
const FRAMES: Record<string, unknown> = {
  Revenues: { taxonomy: "us-gaap", tag: "Revenues", ccp: "CY2023", uom: "USD", label: "Revenues", pts: 2, data: [row(37996, "Ford Motor Co", 176e9, "2023-01-01", "2023-12-31"), row(1, "Other", 5e9, "2023-01-01", "2023-12-31")] },
  RevenueFromContractWithCustomerExcludingAssessedTax: {
    taxonomy: "us-gaap",
    tag: "RevenueFromContractWithCustomerExcludingAssessedTax",
    ccp: "CY2023",
    uom: "USD",
    pts: 3,
    data: [
      row(1018724, "AMAZON.COM, INC.", 574.785e9, "2023-01-01", "2023-12-31"),
      row(789019, "MICROSOFT CORPORATION", 211.915e9, "2022-07-01", "2023-06-30"),
      row(37996, "Ford Motor Co", 1e9, "2023-01-01", "2023-12-31"), // must not override Ford's Revenues value
    ],
  },
};
let urls: string[] = [];

function stub(extra?: (u: URL) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(u.pathname);
      const x = extra?.(u);
      if (x) return x;
      if (u.hostname === "www.sec.gov") return json(TICKERS);
      const fm = /\/frames\/us-gaap\/([^/]+)\//.exec(u.pathname);
      if (fm && FRAMES[fm[1]!]) return json(FRAMES[fm[1]!]);
      return json({ message: "not found" }, 404);
    }),
  );
}
const frameCalls = () => urls.filter((u) => u.includes("/frames/"));

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  urls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

type Out = Record<string, unknown> & { results: { cik: string; val: number; tag?: string; fiscal_period_differs?: boolean; rank: number }[]; notes: string[] };
const compare = async (a: Record<string, unknown>) => (await compareCompanies.run(compareCompanies.inputSchema.parse(a))) as Out;

describe("metric aliases", () => {
  it("maps aliases and gates superseded tags by year", () => {
    expect(canonicalMetric("sales")).toBe("revenue");
    expect(canonicalMetric("eps")).toBe("eps_diluted");
    expect(frameTagsFor("revenue", 2024)).toEqual(["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"]);
    expect(frameTagsFor("revenue", 2015)).toHaveLength(3);
    for (const m of Object.values(FRAME_METRICS)) expect(m.tags.length).toBeLessThanOrEqual(MAX_FRAME_TAGS);
    expect(FRAME_METRIC_INPUTS).toContain("sales");
    expect(FRAME_METRIC_INPUTS).not.toContain("fcf"); // not a frames concept
  });
  it("costs one frames download (3 units) per fallback tag", () => {
    expect(toolCost("compare_companies", { metric: "revenue" })).toBe(9);
    expect(toolCost("compare_companies", { metric: "sales" })).toBe(9);
    expect(toolCost("compare_companies", { metric: "gross_profit" })).toBe(3);
    expect(toolCost("compare_companies", { tag: "Revenues" })).toBe(3);
    expect(toolCost("get_xbrl_concept", { tag: "Revenues" })).toBe(3);
  });
});

describe("compare_companies by metric", () => {
  it("falls back across tags per company, reports the tag, flags fiscal years", async () => {
    stub();
    const r = await compare({ metric: "revenue", period: "CY2023", companies: ["MSFT", "AMZN", "F"] });
    const by = Object.fromEntries(r.results.map((x) => [x.cik, x]));
    expect(by["0000789019"]).toMatchObject({ val: 211.915e9, tag: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", fiscal_period_differs: true });
    expect(by["0000037996"]).toMatchObject({ val: 176e9, tag: "us-gaap:Revenues" });
    expect(by["0000037996"]!.fiscal_period_differs).toBeUndefined();
    expect(r.missing_ciks).toBeUndefined();
    expect(r).toMatchObject({ metric: "revenue", period_basis: "calendar", tags_used: expect.arrayContaining(["us-gaap:Revenues"]) });
    expect(r.notes.join(" ")).toMatch(/fiscal_period_differs.*MICROSOFT/);
    expect(frameCalls()).toHaveLength(2); // SalesRevenueNet skipped for 2023
  });
  it("stops fetching tags once every requested company has a value", async () => {
    stub();
    await compare({ metric: "sales", period: "CY2023", companies: ["F"] });
    expect(frameCalls()).toHaveLength(1);
  });
  it("ranks across the merged tags when no companies are given", async () => {
    stub();
    const r = await compare({ metric: "revenue", period: "CY2023", limit: 2 });
    expect(r.results.map((x) => x.cik)).toEqual(["0001018724", "0000789019"]);
    expect(r.companies_reporting).toBe(4);
  });
  it("reads balance-sheet metrics at the period end and rejects instant periods for flows", async () => {
    stub((u) => (u.pathname.includes("/Assets/") ? json({ taxonomy: "us-gaap", tag: "Assets", ccp: "CY2023Q4I", uom: "USD", pts: 1, data: [{ accn: "a", cik: 37996, entityName: "Ford", end: "2023-12-31", val: 1 }] }) : undefined));
    const r = await compare({ metric: "assets", period: "CY2023" });
    expect(r.period).toBe("CY2023Q4I");
    expect(urls.some((u) => u.endsWith("/CY2023Q4I.json"))).toBe(true);
    await expect(compare({ metric: "revenue", period: "CY2023Q4I" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("tag mode points to metric when companies are missing", async () => {
    stub();
    const r = await compare({ tag: "Revenues", period: "CY2023", companies: ["MSFT", "F"] });
    expect(r.missing_ciks).toEqual(["0000789019"]);
    expect(r.notes.join(" ")).toMatch(/metric: 'revenue'/);
    expect(r.period_basis).toBe("calendar");
  });
  it("requires exactly one of metric or tag and validates the metric", () => {
    const s = compareCompanies.inputSchema;
    expect(s.safeParse({ period: "CY2023" }).success).toBe(false);
    expect(s.safeParse({ period: "CY2023", metric: "revenue", tag: "Revenues" }).success).toBe(false);
    expect(s.safeParse({ period: "CY2023", metric: "bogus" }).success).toBe(false);
    expect(s.safeParse({ period: "CY2023", metric: "revenue" }).success).toBe(true);
  });
  it("calendar period ends", () => {
    expect(calendarPeriodEnd("CY2024")).toBe("2024-12-31");
    expect(calendarPeriodEnd("CY2024Q2I")).toBe("2024-06-30");
  });
});

describe("get_financials fiscal basis and hints", () => {
  it("labels fiscal periods and the fiscal year end", () => {
    const r = computeFinancials(cf, "annual", 2);
    expect(r.period_basis).toBe("fiscal");
    expect(r.fiscal_year_end).toBe("09-27");
    expect(r.notes[0]).toMatch(/fiscal year 2025 ended 2025-09-27/);
  });
  it("gives derived Q4 rows a period_start", () => {
    const r = computeFinancials(cf, "quarterly", 8);
    const q4 = r.periods.find((p) => p.fy === 2025 && p.fp === "Q4")!;
    expect(q4.period_start).toBe("2025-06-29");
  });
  it("hints at quarterly data when a company has no 10-K yet", () => {
    const qOnly = structuredClone(cf);
    for (const c of Object.values(qOnly.facts))
      for (const k of Object.values(c)) for (const u of Object.keys(k.units)) k.units[u] = k.units[u]!.filter((f) => f.form === "10-Q");
    const r = computeFinancials(qOnly, "annual", 5);
    expect(r.periods).toHaveLength(0);
    expect(r.hint).toMatch(/only quarterly \(10-Q\).*period_type: 'quarterly'/);
    expect(computeFinancials(qOnly, "quarterly", 2).periods.length).toBeGreaterThan(0);
  });
  it("accepts metric aliases and rejects unknown names", () => {
    const s = getFinancialsTool.inputSchema;
    expect(s.safeParse({ company: "AAPL", metrics: ["sales", "eps", "fcf"] }).success).toBe(true);
    expect(s.safeParse({ company: "AAPL", metrics: ["bogus"] }).success).toBe(false);
    expect(s.safeParse({ company: "AAPL", metrics: Array(21).fill("revenue") }).success).toBe(false);
  });
});

describe("get_xbrl_concept", () => {
  const facts: Fact[] = [
    { start: "2024-10-01", end: "2025-09-27", val: 10, accn: "a", form: "10-K", filed: "2025-10-31", fy: 2025, fp: "FY" },
    { start: "2025-06-29", end: "2025-09-27", val: 3, accn: "b", form: "10-K", filed: "2025-10-31", fy: 2025, fp: "FY" },
    { start: "2024-10-01", end: "2025-06-28", val: 7, accn: "c", form: "10-Q", filed: "2025-08-01", fy: 2025, fp: "Q3" },
  ];
  it("filters by duration and notes mixed durations", () => {
    expect(durationOf(facts[1]!)).toBe("quarterly");
    expect(durationOf({ end: "2025-01-01" })).toBe("instant");
    const all = selectConceptFacts({ USD: facts }, { framedOnly: false, limit: 10 });
    expect(all.note).toMatch(/mix period lengths/);
    const annual = selectConceptFacts({ USD: facts }, { framedOnly: false, limit: 10, duration: "annual" });
    expect(annual.facts.map((f) => f.val)).toEqual([10]);
    expect(annual.note).toBeUndefined();
    expect(selectConceptFacts({ USD: facts }, { framedOnly: false, limit: 10, duration: "ytd" }).facts.map((f) => f.val)).toEqual([7]);
  });
  const run = (a: Record<string, unknown>) => getXbrlConcept.run(getXbrlConcept.inputSchema.parse({ company: "AAPL", ...a })) as Promise<Record<string, unknown>>;
  const concept = (tag: string) => ({ cik: 320193, taxonomy: "us-gaap", tag, entityName: "Apple Inc.", units: { USD: facts } });
  it("corrects the case of known tags without an extra request", async () => {
    stub((u) => (u.pathname.endsWith("/us-gaap/NetIncomeLoss.json") ? json(concept("NetIncomeLoss")) : undefined));
    const r = await run({ tag: "netincomeloss" });
    expect(r).toMatchObject({ concept: "us-gaap:NetIncomeLoss", tag_corrected_from: "netincomeloss" });
    expect(urls.filter((u) => u.includes("companyfacts"))).toHaveLength(0);
  });
  it("falls back to companyfacts for other mis-cased tags, else suggests tags", async () => {
    stub((u) => (u.pathname.includes("/companyfacts/") ? json(cf) : undefined));
    const r = await run({ tag: "stockholdersequity" });
    expect(r).toMatchObject({ concept: "us-gaap:StockholdersEquity", tag_corrected_from: "us-gaap:stockholdersequity" });
    const e = await run({ tag: "StockholderEquity" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    // "StockholderEquity" is not a known tag: companyconcept 404s, companyfacts suggests the real one
    expect((e as ToolError).details?.did_you_mean).toContain("us-gaap:StockholdersEquity");
  });
  it("keeps the tag input strict", () => {
    const s = getXbrlConcept.inputSchema;
    expect(s.safeParse({ company: "AAPL", tag: "../x" }).success).toBe(false);
    expect(s.safeParse({ company: "AAPL", tag: "Revenues?x=1" }).success).toBe(false);
    expect(s.safeParse({ company: "AAPL", tag: "us-gaap:Assets" }).success).toBe(true);
    expect(s.safeParse({ company: "AAPL", tag: "Assets", duration: "weekly" }).success).toBe(false);
  });
});
