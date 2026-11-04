/** get_filing_document input formats: accession (dashed / 18 digits), CIK, EDGAR URLs; rejections and hints. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILING_INPUT_HINT, filingInputIsDocument, parseAccession, parseCik, parseFilingInput, parseFilingUrl } from "../src/sec/filingRef.js";
import { getFilingDocument } from "../src/tools.js";
import { runTool } from "../src/server.js";
import { ToolError } from "../src/core/errors.js";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { toolCost } from "../src/core/quota.js";

const ACC = "0000320193-24-000123";
const ACC18 = "000032019324000123";
const DOC = `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`;
const INDEX = `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/${ACC}-index.htm`;
const CIK = "0000320193";

describe("parseAccession / parseCik", () => {
  it("accepts dashed and undashed accession numbers", () => {
    expect(parseAccession(ACC)).toBe(ACC);
    expect(parseAccession(ACC18)).toBe(ACC);
    expect(parseAccession(`  ${ACC}\n`)).toBe(ACC);
  });
  it("rejects malformed accession numbers", () => {
    for (const bad of ["", "0000320193-24-00012", "00003201932400012", "0000320193-24-0001234", "x000032019324000123", "0000320193_24_000123", "AAPL"]) expect(parseAccession(bad), bad).toBeUndefined();
  });
  it("accepts CIKs with or without leading zeros, CIK prefix and numbers", () => {
    for (const ok of ["320193", "0000320193", "CIK0000320193", "cik320193", 320193]) expect(parseCik(ok), String(ok)).toBe(CIK);
    for (const bad of ["", "0", "abc", "12345678901", "320193x"]) expect(parseCik(bad), bad).toBeUndefined();
  });
});

describe("parseFilingUrl", () => {
  it("parses a document URL (canonical, query/fragment dropped)", () => {
    expect(parseFilingUrl(DOC)).toEqual({ kind: "document", url: DOC, cik: CIK, accession: ACC });
    expect(parseFilingUrl(`${DOC}?foo=1#bar`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`http://www.sec.gov/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`https://sec.gov/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`www.sec.gov/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`https://www.sec.gov/Archives/edgar/data/0000320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`https://www.sec.gov/ix?doc=/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`https://www.sec.gov/cgi-bin/viewer?action=view&doc=/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingUrl(`https://www.sec.gov/Archives/edgar/data/320193/${ACC}/aapl-20240928.htm`)).toMatchObject({ kind: "document", url: DOC });
  });
  it("parses filing-level URLs (index page, folder, complete submission text)", () => {
    const filing = { kind: "filing", cik: CIK, accession: ACC };
    for (const u of [
      INDEX,
      `${INDEX.replace(/\.htm$/, ".html")}`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/${ACC}.txt`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/index.json`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC}.txt`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC}-index.htm`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC}/`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/${ACC}-index-headers.html`,
    ])
      expect(parseFilingUrl(u), u).toEqual(filing);
  });
  it("rejects non-SEC hosts and unsafe URLs (never fetched) with the format hint", () => {
    for (const bad of [
      `https://evil.example/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://www.sec.gov.evil.example/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://evil.example/?u=https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://user:pw@www.sec.gov/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://www.sec.gov:8443/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `ftp://www.sec.gov/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `file:///etc/passwd`,
      `https://data.sec.gov/submissions/CIK0000320193.json`,
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193`,
      `https://www.sec.gov/ix?doc=https://evil.example/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://www.sec.gov/ix?doc=//evil.example/Archives/edgar/data/320193/${ACC18}/a.htm`,
      `https://www.sec.gov/ix`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/sub/dir.htm`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/..`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/%2e%2e%2fx.htm`,
      `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/a%20b.htm`,
      `https://www.sec.gov/Archives/edgar/data/320193/12345/a.htm`,
      `https://www.sec.gov/Archives/edgar/data/abc/${ACC18}/a.htm`,
      `https://www.sec.gov/Archives/edgar/data/0/${ACC18}/a.htm`,
      `https://www.sec.gov/Archives/edgar/data/320193/`,
      "not a url",
    ]) {
      let err: unknown;
      try {
        parseFilingUrl(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(ToolError);
      expect((err as ToolError).code, bad).toBe("INVALID_INPUT");
      expect((err as ToolError).hint, bad).toBe(FILING_INPUT_HINT);
    }
  });
});

describe("parseFilingInput", () => {
  it("routes values by shape and normalises cik", () => {
    expect(parseFilingInput({ company: "AAPL", accession: ACC })).toEqual({ target: { kind: "filing", accession: ACC }, company: "AAPL" });
    expect(parseFilingInput({ company: "AAPL", accession: ACC18 }).target).toEqual({ kind: "filing", accession: ACC });
    expect(parseFilingInput({ cik: "320193", accession: ACC18 }).target).toEqual({ kind: "filing", accession: ACC, cik: CIK });
    expect(parseFilingInput({ cik: 320193, accession: ACC }).target).toEqual({ kind: "filing", accession: ACC, cik: CIK });
    expect(parseFilingInput({ accession: ACC }).target).toEqual({ kind: "filing", accession: ACC });
    // An accession in url, a URL in accession.
    expect(parseFilingInput({ url: ACC }).target).toEqual({ kind: "filing", accession: ACC });
    expect(parseFilingInput({ accession: DOC }).target).toMatchObject({ kind: "document", url: DOC });
    expect(parseFilingInput({ accession: INDEX }).target).toEqual({ kind: "filing", cik: CIK, accession: ACC });
    // The URL's own CIK wins over a cik argument for filing-level URLs; matching accession is fine.
    expect(parseFilingInput({ url: INDEX, accession: ACC18 }).target).toEqual({ kind: "filing", cik: CIK, accession: ACC });
  });
  it("rejects missing or malformed identification with a hint and example", () => {
    const cases: Record<string, unknown>[] = [
      {},
      { company: "AAPL" },
      { company: "AAPL", accession: "12345" },
      { company: "AAPL", accession: "0000320193-24-00012X" },
      { url: "aapl 10-k" },
      { cik: "abc", accession: ACC },
      { url: INDEX, accession: "0000320193-24-000999" },
    ];
    for (const c of cases) {
      let err: unknown;
      try {
        parseFilingInput(c as never);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(c)).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("INVALID_INPUT");
      expect((err as ToolError).hint).toContain("0000320193-24-000123");
      expect((err as ToolError).hint).toContain('Example: {"company":"AAPL"');
    }
  });
  it("estimates quota by whether a document or a filing lookup is needed", () => {
    expect(filingInputIsDocument({ url: DOC })).toBe(true);
    expect(filingInputIsDocument({ url: INDEX })).toBe(false);
    expect(filingInputIsDocument({ company: "AAPL", accession: ACC })).toBe(false);
    expect(toolCost("get_filing_document", { url: DOC })).toBe(4);
    expect(toolCost("get_filing_document", { url: INDEX })).toBe(10);
    expect(toolCost("get_filing_document", { accession: ACC18 })).toBe(10);
    expect(toolCost("get_filing_document", { url: "https://evil.example/x" })).toBe(4); // rejected locally
  });
});

// ---------------------------------------------------------------- end-to-end through the tool

const HTML = `<html><body><p>FORM 10-K</p><p>Item 1. Business</p><p>${"We make phones. ".repeat(50)}</p><p>Item 1A. Risk Factors</p><p>${"Risky. ".repeat(50)}</p></body></html>`;
const submissions = (cik: string) => ({
  cik,
  name: "Apple Inc.",
  tickers: ["AAPL"],
  exchanges: ["Nasdaq"],
  filings: {
    recent: {
      accessionNumber: [ACC],
      filingDate: ["2024-11-01"],
      reportDate: ["2024-09-28"],
      acceptanceDateTime: ["2024-11-01T06:01:36.000Z"],
      form: ["10-K"],
      items: [""],
      size: [1000],
      isXBRL: [1],
      isInlineXBRL: [1],
      primaryDocument: ["aapl-20240928.htm"],
      primaryDocDescription: ["10-K"],
    },
    files: [],
  },
});
let requested: string[] = [];

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  resetLimiters();
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const m = /^https:\/\/data\.sec\.gov\/submissions\/CIK(\d{10})\.json$/.exec(url);
      if (m) return m[1] === CIK ? Response.json(submissions(m[1])) : new Response("not found", { status: 404 });
      if (url === DOC) return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("unexpected", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

const run = (a: Record<string, unknown>) => getFilingDocument.run(getFilingDocument.inputSchema.parse(a)) as Promise<Record<string, unknown>>;

describe("get_filing_document accepts every common format", () => {
  const filingInputs: [string, Record<string, unknown>][] = [
    ["company + dashed accession", { company: "320193", accession: ACC }],
    ["company + undashed accession", { company: "0000320193", accession: ACC18 }],
    ["cik string without zeros", { cik: "320193", accession: ACC18 }],
    ["cik number", { cik: 320193, accession: ACC }],
    ["accession alone (self-filed)", { accession: ACC }],
    ["index url", { url: INDEX }],
    ["folder url", { url: `https://www.sec.gov/Archives/edgar/data/320193/${ACC18}/` }],
    ["full submission txt url", { url: `https://www.sec.gov/Archives/edgar/data/320193/${ACC}.txt` }],
    ["accession passed as url", { url: ACC18 }],
  ];
  for (const [name, a] of filingInputs)
    it(name, async () => {
      const r = await run({ ...a, max_chars: 500 });
      expect(r).toMatchObject({ url: DOC, cik: CIK, accession: ACC, form: "10-K", filed: "2024-11-01" });
      expect(String(r.text)).toContain("We make phones.");
      // Only SEC hosts are ever requested.
      for (const u of requested) expect(u).toMatch(/^https:\/\/(www|data)\.sec\.gov\//);
    });
  it("document url variants are fetched directly (no submissions lookup)", async () => {
    for (const u of [DOC, `http://sec.gov/Archives/edgar/data/0000320193/${ACC18}/aapl-20240928.htm?x=1`, `https://www.sec.gov/ix?doc=/Archives/edgar/data/320193/${ACC18}/aapl-20240928.htm`]) {
      const r = await run({ url: u, max_chars: 500 });
      expect(r).toMatchObject({ url: DOC, cik: CIK, accession: ACC });
    }
    expect(requested.every((u) => u === DOC)).toBe(true);
  });
  it("accession alone filed by an agent: NOT_FOUND that says to pass company", async () => {
    await expect(run({ accession: "0001193125-24-000123" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const res = await runTool(getFilingDocument, { accession: "0001193125-24-000123", mode: "text", max_chars: 1000, offset: 0 }, "stdio");
    expect((res.content[0] as { text: string }).text).toMatch(/UPSTREAM|NOT_FOUND/);
  });
  it("INVALID_INPUT tool errors carry the accepted formats and an example", async () => {
    const res = await runTool(getFilingDocument, { company: "AAPL", accession: "12345", mode: "text", max_chars: 1000, offset: 0 }, "stdio");
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as { text: string }).text) as { error: { code: string; message: string; hint: string } };
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("18 digits");
    expect(body.error.hint).toContain("Accepted inputs");
    expect(body.error.hint).toContain('{"company":"AAPL","accession":"0000320193-24-000123","mode":"outline"}');
    expect(requested).toEqual([]);
  });
  it("never fetches a non-SEC URL", async () => {
    await expect(run({ url: "https://evil.example/Archives/edgar/data/320193/000032019324000123/a.htm" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(requested).toEqual([]);
  });
  it("describes the formats with a concrete example call", () => {
    expect(getFilingDocument.description).toContain('Example: {"company":"AAPL","accession":"0000320193-24-000123","mode":"outline"}');
    expect(getFilingDocument.description).toContain("000032019324000123");
  });
});
