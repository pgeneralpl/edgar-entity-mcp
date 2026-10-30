/** Second security review of the search UX (PR #9): compare_companies without typo ranking, NFKC, name cap, starts_with minimum. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the typo-ranking primitives (edit distance, per-token fuzzy distance, dice similarity).
vi.mock("../src/core/names.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/core/names.js")>();
  return { ...m, fuzzyTokenDistance: vi.fn(m.fuzzyTokenDistance), editDistance: vi.fn(m.editDistance), dice: vi.fn(m.dice) };
});

import * as names from "../src/core/names.js";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { chargeQuota, resetMinuteCounters, settleQuota, toolCost, type Principal, type QuotaStore } from "../src/core/quota.js";
import { runWithContext, type CallContext } from "../src/core/context.js";
import { ToolError } from "../src/core/errors.js";
import { compareCompanies, lookupBusinessEntity } from "../src/tools.js";
import { resolveCompany } from "../src/sec/tickers.js";
import { STATE_SOURCES } from "../src/states/registry.js";
import { NAME_MAX_CHARS, buildOrder, buildQueryUrl, buildWhere, cleanNameQuery, nameVariants, prepareEntityName } from "../src/states/socrata.js";

// A ticker list of realistic size: compare_companies must stay cheap even against ~10k rows.
const TICKERS = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    ...Array.from({ length: 10_000 }, (_, i) => [1_000_000 + i, `FILLER HOLDINGS ${i} INC`, `F${i}`, null]),
  ],
};
const FRAME = {
  taxonomy: "us-gaap",
  tag: "Revenues",
  ccp: "CY2024",
  uom: "USD",
  label: "Revenues",
  description: "",
  pts: 2,
  data: [
    { accn: "0000000000-24-000001", cik: 789019, entityName: "MICROSOFT CORP", end: "2024-06-30", val: 2 },
    { accn: "0000000000-24-000002", cik: 320193, entityName: "Apple Inc.", end: "2024-09-28", val: 1 },
  ],
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
let urls: string[] = [];
function stub(socrata: (u: URL) => Response = () => json([])) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(u.href);
      if (u.hostname === "www.sec.gov") return json(TICKERS);
      if (u.hostname === "data.sec.gov") return json(FRAME);
      return socrata(u);
    }),
  );
}
const lookup = (a: Record<string, unknown>) => lookupBusinessEntity.run(lookupBusinessEntity.inputSchema.parse(a)) as Promise<Record<string, unknown>>;
const compare = (a: Record<string, unknown>) => compareCompanies.run(compareCompanies.inputSchema.parse(a)) as Promise<Record<string, unknown>>;
const anon: Principal = { id: "ip:test", tier: "anon" };
const httpCtx = (principal: Principal): CallContext => ({ principal, transport: "http", upstream: 0 });
const fuzzyCalls = () =>
  vi.mocked(names.fuzzyTokenDistance).mock.calls.length + vi.mocked(names.editDistance).mock.calls.length + vi.mocked(names.dice).mock.calls.length;

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  resetMinuteCounters();
  urls = [];
  vi.mocked(names.fuzzyTokenDistance).mockClear();
  vi.mocked(names.editDistance).mockClear();
  vi.mocked(names.dice).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

describe("compare_companies resolves without typo ranking", () => {
  it("never invokes fuzzy ranking, even for 25 unknown 40-character names", async () => {
    stub();
    const unknown = Array.from({ length: 24 }, (_, i) => `Qwzx Unknown Company Number ${String(i).padStart(2, "0")} Lmnop`.slice(0, 40));
    const t0 = performance.now();
    const r = (await compare({ tag: "Revenues", period: "CY2024", companies: ["MSFT", ...unknown] })) as {
      results: { cik: string }[];
      unresolved: { company: string; code: string }[];
      unresolved_hint: string;
    };
    const ms = performance.now() - t0;
    expect(fuzzyCalls()).toBe(0);
    expect(r.results.map((x) => x.cik)).toEqual(["0000789019"]);
    expect(r.unresolved).toHaveLength(24);
    expect(r.unresolved[0]).toMatchObject({ company: unknown[0], code: "NOT_FOUND" });
    expect(r.unresolved_hint).toMatch(/search_company/);
    expect(ms).toBeLessThan(1500); // generous bound for slow CI; typo ranking over 10k rows x 24 names is far slower
    // The spy works: the normal (typo-tolerant) resolver does call the fuzzy primitives.
    await resolveCompany("Microsfot Corp").catch(() => undefined);
    expect(fuzzyCalls()).toBeGreaterThan(0);
  });
  it("keeps exact ticker, CIK, exact-name and prefix matches; typos are reported, not guessed", async () => {
    stub();
    const r = (await compare({ tag: "Revenues", period: "CY2024", companies: ["AAPL", "789019", "Microsoft", "Microsfot"] })) as {
      results: { cik: string }[];
      unresolved: { company: string; code: string }[];
    };
    expect(r.results.map((x) => x.cik).sort()).toEqual(["0000320193", "0000789019"]);
    expect(r.unresolved).toEqual([expect.objectContaining({ company: "Microsfot", code: "NOT_FOUND" })]);
    expect(fuzzyCalls()).toBe(0);
  });
  it("fails with NOT_FOUND (and no frames request) when nothing resolves", async () => {
    stub();
    const e = (await compare({ tag: "Revenues", period: "CY2024", companies: ["Qwzx One", "Qwzx Two"] }).catch((x: unknown) => x)) as ToolError;
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.hint).toMatch(/search_company/);
    expect((e.details?.unresolved as unknown[]).length).toBe(2);
    expect(e.details?.did_you_mean).toBeUndefined();
    expect(urls.some((u) => u.includes("data.sec.gov"))).toBe(false);
  });
});

describe("entity names: NFKC, length cap, starts_with minimum", () => {
  const ny = STATE_SOURCES.NY!;
  it("NFKC-normalises fullwidth names before the allowlist", async () => {
    expect(cleanNameQuery("ＡＣＭＥ　Ｉｎｃ．")).toBe("ACME INC.");
    expect(nameVariants("ＡＣＭＥ　Ｉｎｃ．")).toContain("ACME INC.");
    expect(buildWhere(ny, { name: "ＡＣＭＥ　Ｉｎｃ．", mode: "exact" })).toContain("'ACME INC.'");
    stub(() => json([]));
    await lookup({ name: "ＡＣＭＥ　Ｗｉｄｇｅｔｓ", states: ["NY"] });
    expect(new URL(urls[0]!).searchParams.get("$where")).toContain("%ACME%WIDGETS%");
  });
  it("caps names at 100 characters before any query is built, without a charge", async () => {
    expect(lookupBusinessEntity.inputSchema.safeParse({ name: "x".repeat(NAME_MAX_CHARS + 1) }).success).toBe(false);
    // NFKC can lengthen a name (U+FDFA expands to 18 characters): checked again after normalisation.
    const expanding = "Acme ".repeat(18) + "\uFDFA";
    expect(expanding.length).toBeLessThanOrEqual(NAME_MAX_CHARS);
    expect(() => prepareEntityName(expanding)).toThrow(/100 characters/);
    expect(() => buildWhere(ny, { name: expanding, mode: "exact" })).toThrow(ToolError);
    expect(() => buildOrder(ny, expanding)).toThrow(ToolError);
    stub(() => json([]));
    const refunds: number[] = [];
    const store: QuotaStore = { consume: async () => ({ ok: true }), refund: (_p, u) => refunds.push(u) };
    const args = { name: expanding, states: ["NY", "CO"], match: "exact" };
    await runWithContext(httpCtx(anon), async () => {
      await chargeQuota(anon, "lookup_business_entity", args, store);
      await expect(lookup(args)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      settleQuota();
    });
    expect(refunds).toEqual([toolCost("lookup_business_entity", args)]);
    expect(urls).toEqual([]);
  });
  it("keeps the query URL short for the longest allowed names", () => {
    const worst = [
      "CO AND CO INC ".repeat(8).slice(0, NAME_MAX_CHARS),
      "W&W ".repeat(25).slice(0, NAME_MAX_CHARS),
      "THE CORPORATION AND COMPANY LIMITED INCORPORATED AND CO LTD CORP INC LLC LP LLP AND CO AND CO INC",
      "Ｘ".repeat(NAME_MAX_CHARS),
    ];
    for (const name of worst)
      for (const src of Object.values(STATE_SOURCES))
        for (const mode of ["exact", "contains", "starts_with"] as const) {
          let where: string;
          try {
            where = buildWhere(src, { name, mode });
          } catch (e) {
            expect((e as ToolError).code).toBe("INVALID_INPUT"); // e.g. contains without a 3+ character word
            continue;
          }
          const url = buildQueryUrl(src, where, 300, { order: buildOrder(src, name), offset: 500 });
          expect(url.length).toBeLessThan(4000);
        }
  });
  it("starts_with needs a name word of 2+ characters", async () => {
    stub(() => json([]));
    await expect(lookup({ name: "A.", states: ["NY"], match: "starts_with" }).catch((e: ToolError) => e.code)).resolves.toBe("INVALID_INPUT");
    await expect(lookup({ name: "A B Inc", states: ["NY"], match: "starts_with" })).rejects.toThrow(/2\+/);
    expect(() => buildWhere(ny, { name: "A B", mode: "starts_with" })).toThrow(ToolError);
    expect(urls).toEqual([]);
    await lookup({ name: "AB", states: ["NY"], match: "starts_with" });
    await lookup({ name: "A B", states: ["NY"], match: "exact" });
    expect(urls).toHaveLength(2);
  });
});
