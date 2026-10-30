/** Security review of the search UX (PR #9): SoQL hardening, enumeration limits, CPU caps, OR window, count promise. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { chargeQuota, resetMinuteCounters, settleQuota, toolCost, type Principal, type QuotaStore } from "../src/core/quota.js";
import { runWithContext, type CallContext } from "../src/core/context.js";
import { ToolError } from "../src/core/errors.js";
import { compareCompanies, lookupBusinessEntity, searchCompany } from "../src/tools.js";
import { rankCompanies, resolveCompany, suggestCompanies, type TickerRow } from "../src/sec/tickers.js";
import { STATE_SOURCES } from "../src/states/registry.js";
import { ANON_MAX_OFFSET, buildOrder, buildWhere, multiRowMaxOffset, nameVariants, searchState, soqlString } from "../src/states/socrata.js";

const TICKERS = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
  ],
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
let urls: string[] = [];
function stub(socrata: (u: URL) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(u.href);
      if (u.hostname === "www.sec.gov") return json(TICKERS);
      return socrata(u);
    }),
  );
}
const lookup = (a: Record<string, unknown>) => lookupBusinessEntity.run(lookupBusinessEntity.inputSchema.parse(a)) as Promise<Record<string, unknown>>;
const anon: Principal = { id: "ip:test", tier: "anon" };
const key: Principal = { id: "key:test", tier: "key" };
const httpCtx = (principal: Principal): CallContext => ({ principal, transport: "http", upstream: 0 });

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  resetMinuteCounters();
  urls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

describe("include_total count promise", () => {
  it("does not leave an unhandled rejection when the page fetch fails first", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      stub(async (u) => {
        if (u.searchParams.get("$select")?.startsWith("count(")) {
          await new Promise((r) => setTimeout(r, 30));
          return json({ message: "count failed" }, 400);
        }
        return json({ message: "boom" }, 400);
      });
      await expect(searchState("NY", { name: "Tiffany", mode: "contains", limit: 5, includeTotal: true })).rejects.toBeInstanceOf(Error);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  it("a failed count leaves total unknown instead of failing the page", async () => {
    stub((u) => (u.searchParams.get("$select")?.startsWith("count(") ? json({ message: "no" }, 400) : json([{ dos_id: "1", current_entity_name: "TIFFANY LLC" }])));
    const r = await searchState("NY", { name: "Tiffany", mode: "exact", limit: 5, offset: 1, includeTotal: true });
    expect(r.entities.length).toBe(1);
    expect(r.total).toBe(2); // last page: offset + count
  });
});

describe("SoQL hardening", () => {
  const ny = STATE_SOURCES.NY!;
  it("soqlString doubles quotes and strips backslashes", () => {
    expect(soqlString("O'BRIEN")).toBe("'O''BRIEN'");
    expect(soqlString("A\\' OR 1=1 --")).toBe("'A'' OR 1=1 --'");
    expect(soqlString("\\\\")).toBe("''");
  });
  it("only allowlisted characters of the name reach $where and $order, in every mode", () => {
    const raw = "Acme\\' ) OR (1=1 \u0000 ; -- %_ \"x\"";
    for (const mode of ["exact", "contains", "starts_with"] as const) {
      const where = buildWhere(ny, { name: raw, mode });
      const order = buildOrder(ny, raw);
      for (const s of [where, order]) {
        expect(s).not.toContain("\\");
        expect(s).not.toContain('"');
        expect(s).not.toContain(";");
        expect(s).not.toContain("(1=1");
        expect(s).not.toContain("\u0000");
      }
    }
    for (const v of nameVariants(raw, { addSuffixes: true })) expect(v).toMatch(/^[A-Z0-9 &.,'-]+$/);
    expect(nameVariants("AT&T Inc.")).toContain("AT&T INC.");
    expect(nameVariants("Macy's, Inc.")).toContain("MACY'S, INC.");
  });
  it("entity_id is allowlisted (schema and query builder)", async () => {
    const s = lookupBusinessEntity.inputSchema;
    expect(s.safeParse({ entity_id: "1234-56" }).success).toBe(true);
    expect(s.safeParse({ entity_id: "1' OR '1'='1" }).success).toBe(false);
    expect(s.safeParse({ entity_id: "a\\b" }).success).toBe(false);
    expect(s.safeParse({ entity_id: "x".repeat(41) }).success).toBe(false);
    expect(() => buildWhere(ny, { entityId: "1 OR 1", mode: "exact" })).toThrow(ToolError);
    expect(buildWhere(ny, { entityId: " 123 ", mode: "exact" })).toBe("dos_id = '123'");
  });
});

describe("enumeration limits", () => {
  const nyRows = (n: number) => Array.from({ length: n }, (_, i) => ({ dos_id: String(i), current_entity_name: `TIFFANY ${i} LLC` }));
  it("caps offset for anonymous HTTP callers only, without charging the rejected call", async () => {
    stub(() => json(nyRows(3)));
    const refunds: number[] = [];
    const store: QuotaStore = { consume: async () => ({ ok: true }), refund: (_p, u) => refunds.push(u) };
    const args = { name: "Tiffany", states: ["NY"], offset: ANON_MAX_OFFSET + 1 };
    const ctx = httpCtx(anon);
    await runWithContext(ctx, async () => {
      await chargeQuota(anon, "lookup_business_entity", args, store);
      await expect(lookup(args)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      settleQuota();
    });
    expect(refunds).toEqual([toolCost("lookup_business_entity", args)]); // fully refunded
    expect(urls).toEqual([]);
    // API-key callers and local (stdio) use keep the full range.
    await runWithContext(httpCtx(key), () => lookup(args));
    await lookup(args);
    await runWithContext(httpCtx(anon), () => lookup({ ...args, offset: ANON_MAX_OFFSET }));
  });
  it("charges one extra unit for pages after the first and keeps it at settlement", async () => {
    expect(toolCost("lookup_business_entity", { states: ["NY"] })).toBe(1);
    expect(toolCost("lookup_business_entity", { states: ["NY"], offset: 5 })).toBe(2);
    expect(toolCost("lookup_business_entity", { states: ["NY", "CO"], offset: 5, include_total: true })).toBe(5);
    stub(() => json(nyRows(3)));
    const refunds: number[] = [];
    const store: QuotaStore = { consume: async () => ({ ok: true }), refund: (_p, u) => refunds.push(u) };
    const args = { name: "Tiffany", states: ["NY"], offset: 5 };
    const ctx = httpCtx(anon);
    await runWithContext(ctx, async () => {
      await chargeQuota(anon, "lookup_business_entity", args, store);
      await lookup(args);
      expect(ctx.upstream).toBe(1);
      settleQuota();
    });
    expect(refunds).toEqual([]); // 1 request + 1 surcharge = the full reservation of 2
  });
  it("contains mode needs a name word of 3+ characters", async () => {
    stub(() => json([]));
    await expect(lookup({ name: "A B", states: ["NY"] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(lookup({ name: "AB Inc", states: ["NY"] })).rejects.toThrow(/3\+/);
    expect(urls).toEqual([]);
    await expect(lookup({ name: "A B", states: ["NY"], match: "exact" })).resolves.toBeTruthy();
    await expect(lookup({ name: "IBM", states: ["NY"] })).resolves.toBeTruthy();
  });
});

describe("CPU caps for fuzzy matching", () => {
  const rows: TickerRow[] = [{ cik: 789019, name: "MICROSOFT CORP", ticker: "MSFT", exchange: "Nasdaq" }];
  it("skips typo matching and suggestions for long queries", () => {
    expect(rankCompanies(rows, "Microsfot", 5).length).toBe(1);
    expect(rankCompanies(rows, "Microsfot " + "x".repeat(60), 5)).toEqual([]);
    expect(rankCompanies(rows, "Microsfot a b c d e f g h", 5)).toEqual([]); // 9 tokens
    expect(suggestCompanies(rows, "Microsofd", 5).length).toBe(1);
    expect(suggestCompanies(rows, "Microsofd " + "y".repeat(60), 5)).toEqual([]);
  });
  it("compare_companies bounds company items and resolves without did_you_mean", async () => {
    expect(compareCompanies.inputSchema.safeParse({ tag: "Revenues", period: "CY2024", companies: ["x".repeat(41)] }).success).toBe(false);
    stub(() => json([]));
    const e = (await compareCompanies.run(compareCompanies.inputSchema.parse({ tag: "Revenues", period: "CY2024", companies: ["qqqqzzzz"] })).catch((x: unknown) => x)) as ToolError;
    expect(e.code).toBe("NOT_FOUND");
    expect(e.details?.did_you_mean).toBeUndefined();
    const s = (await resolveCompany("qqqqzzzz").catch((x: unknown) => x)) as ToolError;
    expect(Array.isArray(s.details?.did_you_mean)).toBe(true);
    const r = (await searchCompany.run({ query: "z".repeat(100), limit: 5 })) as { did_you_mean: unknown[] };
    expect(r.did_you_mean).toEqual([]);
  });
});

describe("Oregon row window", () => {
  const or = STATE_SOURCES.OR!;
  const max = multiRowMaxOffset(or);
  it("returns past-window pages without a request and without a charge", async () => {
    expect(max).toBe(59);
    stub(() => json([]));
    const r = (await lookup({ name: "Tiffany", states: ["OR"], offset: max + 1 })) as { count: number; has_more: boolean; by_state: { OR: { note?: string } } };
    expect(r).toMatchObject({ count: 0, has_more: false });
    expect(r.by_state.OR.note).toMatch(/300 rows/);
    expect(urls).toEqual([]);
    expect(toolCost("lookup_business_entity", { states: ["OR"], offset: max + 1 })).toBe(0);
    expect(toolCost("lookup_business_entity", { states: ["OR", "NY"], offset: max + 1 })).toBe(2); // NY + page surcharge
    expect(toolCost("lookup_business_entity", { offset: max + 1, include_total: true })).toBe(9); // 4 states x 2 + 1
  });
  it("never points next_offset past the window", async () => {
    const all = Array.from({ length: 300 }, (_, i) => ({ registry_number: String(1000 + Math.floor(i / 2)), business_name: `TIFFANY ${Math.floor(i / 2)} LLC` }));
    stub((u) => json(all.slice(0, Number(u.searchParams.get("$limit")))));
    const r = (await lookup({ name: "Tiffany", states: ["OR"], offset: 55, limit: 5 })) as { count: number; has_more: boolean; next_offset?: number; by_state: { OR: { note?: string } } };
    expect(r.count).toBe(5);
    expect(r.has_more).toBe(false);
    expect(r.next_offset).toBeUndefined();
    expect(r.by_state.OR.note).toMatch(/300 rows/);
  });
});
