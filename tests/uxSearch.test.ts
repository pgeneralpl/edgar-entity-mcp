/** search_company / lookup_business_entity UX: did-you-mean, pagination, totals (fetch stubbed, no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { toolCost } from "../src/core/quota.js";
import { ToolError } from "../src/core/errors.js";
import { lookupBusinessEntity, searchCompany } from "../src/tools.js";
import { resolveCompany } from "../src/sec/tickers.js";
import { MAX_OFFSET } from "../src/states/socrata.js";

const TICKERS = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1326801, "Meta Platforms, Inc.", "META", "Nasdaq"],
  ],
};
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
let urls: string[] = [];

function stub(socrata: (u: URL) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(u.href);
      if (u.hostname === "www.sec.gov") return json(TICKERS);
      return json(socrata(u));
    }),
  );
}

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

describe("search_company", () => {
  it("finds typos and former names from the cached list only", async () => {
    stub(() => []);
    const r = (await searchCompany.run({ query: "Microsfot", limit: 5 })) as { matches: { tickers: string[]; score: number }[] };
    expect(r.matches[0]!.tickers).toEqual(["MSFT"]);
    const f = (await searchCompany.run({ query: "facebook", limit: 5 })) as { matches: { tickers: string[]; matched_former_name?: string }[] };
    expect(f.matches[0]).toMatchObject({ tickers: ["META"], matched_former_name: "Facebook Inc" });
    await searchCompany.run({ query: "Aple", limit: 5 });
    expect(urls.filter((u) => u.includes("sec.gov")).length).toBe(1); // ticker file fetched once, then cached
  });
  it("returns did_you_mean and a lookup_business_entity hint when nothing matches", async () => {
    stub(() => []);
    const r = (await searchCompany.run({ query: "Tiffany and Company", limit: 5 })) as Record<string, unknown>;
    expect(r.matches).toEqual([]);
    expect(Array.isArray(r.did_you_mean)).toBe(true);
    expect(String(r.hint)).toContain("lookup_business_entity");
    expect(String(r.edgar_company_search_url)).toMatch(/^https:\/\/www\.sec\.gov\/cgi-bin\/browse-edgar\?action=getcompany/);
  });
  it("does not silently resolve a typo'd company argument", async () => {
    stub(() => []);
    const e = await resolveCompany("Microsfot").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe("AMBIGUOUS");
    expect(JSON.stringify((e as ToolError).details)).toContain("0000789019");
    const nf = (await resolveCompany("qqqqzzzz").catch((x: unknown) => x)) as ToolError;
    expect(nf.code).toBe("NOT_FOUND");
    expect(nf.hint).toContain("lookup_business_entity");
    expect(await resolveCompany("Facebook")).toMatchObject({ cik: "0001326801" });
  });
});

describe("lookup_business_entity pagination and totals", () => {
  const nyRows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ dos_id: String(from + i), current_entity_name: `TIFFANY ${from + i} LLC`, entity_type: "DOMESTIC LIMITED LIABILITY COMPANY" }));
  const run = (a: Record<string, unknown>) =>
    lookupBusinessEntity.run(lookupBusinessEntity.inputSchema.parse({ name: "Tiffany", states: ["NY"], ...a })) as Promise<Record<string, any>>;

  it("pages with $offset/$limit+1 and reports has_more/next_offset", async () => {
    stub((u) => {
      const off = Number(u.searchParams.get("$offset") ?? 0);
      const lim = Number(u.searchParams.get("$limit"));
      return nyRows(Math.min(lim, 12 - off), off);
    });
    const p1 = await run({ limit: 5 });
    expect(p1.count).toBe(5);
    expect(p1).toMatchObject({ offset: 0, has_more: true, next_offset: 5 });
    expect(p1.by_state.NY).toMatchObject({ count: 5, has_more: true, next_offset: 5, active_only_dataset: true });
    expect(p1.total).toBeUndefined();
    const q = new URL(p1.by_state.NY.query_url);
    expect(q.searchParams.get("$limit")).toBe("6");
    expect(q.searchParams.get("$order")).toMatch(/^case\(/);
    const p3 = await run({ limit: 5, offset: 10 });
    expect(p3).toMatchObject({ count: 2, has_more: false, total: 12 });
    expect(p3.next_offset).toBeUndefined();
  });
  it("include_total issues one count query per state and doubles the cost", async () => {
    stub((u) => (u.searchParams.get("$select")?.startsWith("count(") ? [{ n: "489" }] : nyRows(6)));
    const r = await run({ limit: 5, include_total: true });
    expect(r.total).toBe(489);
    expect(r.by_state.NY.total).toBe(489);
    expect(urls.filter((u) => u.includes("count")).length).toBe(1);
    expect(toolCost("lookup_business_entity", { states: ["NY"], include_total: true })).toBe(2);
    expect(toolCost("lookup_business_entity", { include_total: true })).toBe(10);
    expect(toolCost("lookup_business_entity", { states: ["NY", "CO"] })).toBe(2);
  });
  it("paginates row-per-name datasets (OR) over grouped entities", async () => {
    // 3 rows per entity, 7 entities, ordered by entity.
    const all = Array.from({ length: 21 }, (_, i) => ({ registry_number: String(100 + Math.floor(i / 3)), business_name: `TIFFANY ${Math.floor(i / 3)} LLC`, associated_name_type: "MAILING ADDRESS" }));
    stub((u) => all.slice(0, Number(u.searchParams.get("$limit"))));
    const p1 = (await run({ states: ["OR"], limit: 2 })) as Record<string, any>;
    expect(p1.results.map((e: { entity_id: string }) => e.entity_id)).toEqual(["100", "101"]);
    expect(p1.by_state.OR).toMatchObject({ has_more: true, next_offset: 2 });
    expect(new URL(p1.by_state.OR.query_url).searchParams.get("$offset")).toBeNull(); // window from the start
    const p4 = (await run({ states: ["OR"], limit: 2, offset: 6 })) as Record<string, any>;
    expect(p4.results.map((e: { entity_id: string }) => e.entity_id)).toEqual(["106"]);
    expect(p4).toMatchObject({ has_more: false, total: 7 });
  });
  it("notes that active_only does not apply to active-only datasets", async () => {
    stub(() => []);
    const r = await run({ active_only: true });
    expect(r.active_only_note).toMatch(/NY, OR and PA/);
  });
  it("keeps offsets and limits bounded", () => {
    const s = lookupBusinessEntity.inputSchema;
    expect(s.safeParse({ name: "x y", offset: MAX_OFFSET + 1 }).success).toBe(false);
    expect(s.safeParse({ name: "x y", offset: -1 }).success).toBe(false);
    expect(s.safeParse({ name: "x y", limit: 26 }).success).toBe(false);
    expect(s.safeParse({ name: "x y", offset: 1.5 }).success).toBe(false);
  });
});
