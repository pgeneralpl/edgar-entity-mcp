import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildPeriods, computeFinancials } from "../src/sec/financials.js";
import type { CompanyFacts } from "../src/sec/xbrlTypes.js";

const cf = JSON.parse(readFileSync(new URL("./fixtures/companyfacts-aapl-trimmed.json", import.meta.url), "utf8")) as CompanyFacts;

describe("financials normalization (AAPL fixture)", () => {
  it("builds annual periods with correct fiscal years", () => {
    const p = buildPeriods(cf, "annual");
    const fy2025 = p.find((x) => x.end === "2025-09-27")!;
    expect(fy2025.fy).toBe(2025);
    expect(fy2025.accn).toBe("0000320193-25-000079");
    // comparatives from later 10-Ks must not create duplicate periods
    expect(new Set(p.map((x) => x.end)).size).toBe(p.length);
  });
  it("normalizes FY2025 metrics matching the 10-K", () => {
    const r = computeFinancials(cf, "annual", 3);
    const fy = r.periods[0]!;
    expect(fy).toMatchObject({
      fy: 2025,
      fp: "FY",
      revenue: 416161000000,
      net_income: 112010000000,
      eps_diluted: 7.46,
      eps_basic: 7.49,
      total_assets: 359241000000,
      cash: 35934000000,
      operating_cash_flow: 111482000000,
      capex: 12715000000,
    });
    expect(fy.free_cash_flow).toBe(111482000000 - 12715000000);
    expect(r.tags_used.revenue).toEqual(["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"]);
    expect(r.currency).toBe("USD");
  });
  it("produces 3-month quarters, YTD-differenced cash flow, and a derived Q4", () => {
    const r = computeFinancials(cf, "quarterly", 8);
    const q4 = r.periods.find((p) => p.fy === 2025 && p.fp === "Q4")!;
    expect(q4.derived_period).toBe(true);
    expect(q4.revenue).toBe(102466000000); // 416,161 - 313,695 (9M)
    expect(q4.eps_diluted).toBeUndefined();
    const q2 = r.periods.find((p) => p.fy === 2026 && p.fp === "Q2")!;
    expect(q2.revenue).toBe(111184000000);
    expect(typeof q2.operating_cash_flow).toBe("number");
    expect(r.notes.join(" ")).toMatch(/YTD difference/);
  });
  it("respects limit and metric subset", () => {
    const r = computeFinancials(cf, "annual", 2, ["revenue"]);
    expect(r.periods).toHaveLength(2);
    expect(Object.keys(r.periods[0]!)).not.toContain("net_income");
  });
});
