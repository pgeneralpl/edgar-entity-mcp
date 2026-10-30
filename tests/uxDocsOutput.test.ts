/** get_filing_document outline/paging, outputSchema + structuredContent, SSE charset, prompt wording. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer, runTool } from "../src/server.js";
import { ALL_TOOLS, archiveMeta, DOC_DEFAULT_MAX_CHARS, getFilingDocument } from "../src/tools.js";
import { detectForm, extractSection, htmlToText, outlineSections, SECTION_TITLES, sectionTitle } from "../src/sec/documents.js";
import { withUtf8Charset } from "../src/http/handler.js";
import { loadConfig, resetConfig } from "../src/config.js";
import { MemoryCache, setCache } from "../src/core/cache.js";
import { resetLimiters } from "../src/core/http.js";
import { toolCost } from "../src/core/quota.js";

/** Real production outputs (2026-10-29, text fields trimmed), one or more per tool. */
const REAL = JSON.parse(readFileSync(new URL("./fixtures/tool-outputs.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>[]>;

const item = (id: string, title: string, body: string) => `<p>Item ${id}. ${title}</p><p>${body}</p>`;
const HTML = `<html><body><p>TABLE OF CONTENTS</p>
<table><tr><td>Item 1.</td><td>Business</td></tr><tr><td>Item 1A.</td><td>Risk Factors</td></tr><tr><td>Item 7.</td><td>MD&amp;A</td></tr></table>
${item("1", "Business", "We make widgets. ".repeat(400))}
${item("1A", "Risk Factors", "Competition is intense and ’quotes’ matter. ".repeat(600))}
${item("7", "Management's Discussion and Analysis", "Revenue grew. ".repeat(200))}
${item("8", "Financial Statements", "See below.")}
</body></html>`;
const URL_ = "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm";
let fetches = 0;

beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  setCache(new MemoryCache(), new MemoryCache());
  fetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetches++;
      return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetConfig(undefined);
  setCache(undefined);
  resetLimiters();
});

type Doc = Record<string, unknown> & { text?: string; outline?: { id: string; offset: number; chars: number }[]; total_chars: number; next_offset?: number };
const doc = async (a: Record<string, unknown>) => (await getFilingDocument.run(getFilingDocument.inputSchema.parse(a))) as Doc;

describe("get_filing_document", () => {
  it("defaults to 10,000 characters per page and pages with next_offset", async () => {
    const d = await doc({ url: URL_ });
    expect(DOC_DEFAULT_MAX_CHARS).toBe(10_000);
    expect(d.total_chars).toBeGreaterThan(30_000);
    expect(d.next_offset).toBe(10_000);
    const d2 = await doc({ url: URL_, offset: d.next_offset });
    expect(d2.offset).toBe(10_000);
    expect(fetches).toBe(1); // second page from the cache
  });
  it("url mode reports cik, accession and index_url from the path, with no extra request", async () => {
    const d = await doc({ url: URL_, max_chars: 500 });
    expect(d).toMatchObject({
      cik: "0000320193",
      accession: "0000320193-25-000079",
      index_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/0000320193-25-000079-index.htm",
    });
    expect(fetches).toBe(1);
    expect(archiveMeta("https://www.sec.gov/other")).toEqual({});
  });
  it("outline mode returns items with offsets/lengths and no text", async () => {
    const d = await doc({ url: URL_, mode: "outline" });
    expect(d.text).toBeUndefined();
    expect(d.untrusted_content).toBeUndefined();
    expect(d.outline!.map((o) => o.id)).toEqual(["1", "1A", "7", "8"]);
    const ra = d.outline!.find((o) => o.id === "1A")!;
    expect(ra.chars).toBeGreaterThan(20_000);
    // the outline offset reads the same text as section: '1A'
    const bySection = await doc({ url: URL_, section: "1A", max_chars: 1000 });
    const byOffset = await doc({ url: URL_, offset: ra.offset, max_chars: 1000 });
    expect(byOffset.text!.replace(/id=\w+/g, "")).toContain("Item 1A. Risk Factors");
    expect(bySection.text!).toContain("Item 1A. Risk Factors");
    expect(JSON.stringify(d).length).toBeLessThan(1500);
    expect(getFilingDocument.outputSchema!.safeParse(d).success).toBe(true);
  });
  it("outline spans match extractSection and are ordered", () => {
    const t = htmlToText(HTML);
    const o = outlineSections(t);
    for (const x of o) {
      const s = extractSection(t, x.id)!;
      expect(t.slice(x.offset, x.offset + x.chars).trim()).toBe(s.text);
    }
    expect(o.map((x) => x.offset)).toEqual([...o.map((x) => x.offset)].sort((a, b) => a - b));
    expect(outlineSections("no items here")).toEqual([]);
  });
  it("keeps inputs bounded and the cost unchanged", () => {
    const s = getFilingDocument.inputSchema;
    expect(s.safeParse({ url: URL_, mode: "toc" }).success).toBe(false);
    expect(s.safeParse({ url: URL_, max_chars: 100_001 }).success).toBe(false);
    expect(s.safeParse({ url: URL_, max_chars: 499 }).success).toBe(false);
    expect(s.safeParse({ url: URL_, offset: 20_000_001 }).success).toBe(false);
    expect(toolCost("get_filing_document", { url: URL_, mode: "outline" })).toBe(4);
    expect(toolCost("get_filing_document", { company: "AAPL", accession: "x" })).toBe(10);
  });
});

describe("outputSchema + structuredContent", () => {
  it("every tool has an object outputSchema that accepts real production outputs", () => {
    for (const t of ALL_TOOLS) {
      expect(t.outputSchema, t.name).toBeDefined();
      const samples = REAL[t.name] ?? [];
      expect(samples.length, t.name).toBeGreaterThan(0);
      for (const r of samples) {
        const p = t.outputSchema!.safeParse(r);
        expect(p.success, `${t.name}: ${p.error?.message}`).toBe(true);
      }
    }
  });
  it("tolerates nulls and new fields from upstream, rejects a wrong shape", () => {
    const s = ALL_TOOLS.find((t) => t.name === "get_xbrl_concept")!.outputSchema!;
    const r = structuredClone(REAL.get_xbrl_concept![0]!);
    expect(s.safeParse({ ...r, label: null, description: null, extra_field: 1 }).success).toBe(true);
    expect(s.safeParse({ ...r, facts: "nope" }).success).toBe(false);
  });
  it("is advertised in tools/list and returned alongside the JSON text", async () => {
    const server = createServer("stdio");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b as never);
    const tools = await client.listTools();
    for (const t of tools.tools) expect((t.outputSchema as { type?: string } | undefined)?.type, t.name).toBe("object");
    const fd = tools.tools.find((t) => t.name === "get_filing_document")!;
    expect(Object.keys((fd.outputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["outline", "text", "next_offset"]));
    const r = (await client.callTool({ name: "list_supported_states", arguments: {} })) as { content: { text: string }[]; structuredContent: unknown };
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0]!.text));
    await client.close();
  });
  it("errors carry no structuredContent", async () => {
    const def = ALL_TOOLS.find((t) => t.name === "get_filing_document")!;
    const r = await runTool(def, { mode: "text", max_chars: 1000, offset: 0 }, "stdio");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toContain("INVALID_INPUT");
  });
});

describe("minor items", () => {
  it("adds charset=utf-8 to SSE responses only, keeping the stream", async () => {
    const sse = withUtf8Charset(new Response("event: message\ndata: {\"x\":\"’\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } }));
    expect(sse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sse.headers.get("mcp-session-id")).toBe("s1");
    expect(await sse.text()).toContain("’");
    const j = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(withUtf8Charset(j)).toBe(j);
    const already = new Response("", { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    expect(withUtf8Charset(already)).toBe(already);
  });
  it("research prompt explains DE/CA registries are unavailable", async () => {
    const server = createServer("stdio");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b as never);
    const p = JSON.stringify((await client.getPrompt({ name: "company_research_brief", arguments: { company: "AAPL" } })).messages);
    expect(p).toMatch(/Delaware and California registries are not available/);
    expect(p).toMatch(/HQ state/);
    await client.close();
  });
});

describe("form-aware item titles", () => {
  it("detects the form from the form type or the cover page", () => {
    expect(detectForm("anything", "10-K/A")).toBe("10-K");
    expect(detectForm("UNITED STATES\nFORM 10-Q\nQUARTERLY REPORT")).toBe("10-Q");
    expect(detectForm("no cover")).toBeUndefined();
    expect(sectionTitle("1", "10-K")).toBe("Business");
    expect(sectionTitle("2", "10-Q")).toBe("Management's Discussion and Analysis (MD&A)");
    expect(sectionTitle("1A", "10-Q")).toBe("Risk Factors");
    expect(sectionTitle("2")).toBe(SECTION_TITLES["2"]);
  });
  it("outline and section titles use the detected form", async () => {
    const html10k = HTML.replace("<body>", "<body><p>FORM 10-K</p>");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html10k, { status: 200, headers: { "content-type": "text/html" } })));
    const d = await doc({ url: URL_, mode: "outline" });
    expect((d.outline as unknown as { id: string; title: string }[]).find((o) => o.id === "1")!.title).toBe("Business");
    const s = await doc({ url: URL_, section: "1", max_chars: 500 });
    expect((s.section as { title: string }).title).toBe("Business");
  });
});
