/** Outline cost (single pass, known items only), synthetic fixture names, output-schema mismatches, responseChars. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { runTool } from "../src/server.js";
import type { ToolDef } from "../src/tools.js";
import { extractSection, outlineSections, OUTLINE_MAX_ITEMS, SECTION_TITLES } from "../src/sec/documents.js";
import { setUsageHooks, type UsageResult } from "../src/core/usage.js";

afterEach(() => {
  setUsageHooks({});
  vi.restoreAllMocks();
});

describe("outlineSections", () => {
  it("matches extractSection for every known item, including repeated table-of-contents headings", () => {
    const toc = ["1", "1A", "7", "7A", "8"].map((id) => `Item ${id}. ${SECTION_TITLES[id]}`).join("\n");
    const body = ["1", "1A", "1A", "7", "7A", "8", "99"].map((id) => `Item ${id}. Heading\n${"Text. ".repeat(50 + id.length * 10)}`).join("\n");
    const t = `${toc}\n\n${body}`;
    const o = outlineSections(t, "10-K");
    expect(o.map((x) => x.id)).toEqual(["1", "1A", "7", "7A", "8"]); // "99" is not a known item
    for (const x of o) {
      const s = extractSection(t, x.id)!;
      expect({ offset: x.offset, chars: x.chars }).toEqual({ offset: s.start, chars: s.end - s.start });
    }
  });
  it("stays linear on a large document with thousands of headings", () => {
    // ~2 MB of text with 20,000 headings cycling through every 1–99 id (known and unknown).
    const ids = Array.from({ length: 99 }, (_, i) => String(i + 1));
    const parts: string[] = [];
    for (let i = 0; i < 20_000; i++) parts.push(`Item ${ids[i % ids.length]}. Heading\n${"x".repeat(80)}`);
    const t = parts.join("\n");
    const t0 = performance.now();
    const o = outlineSections(t, "10-K");
    const ms = performance.now() - t0;
    expect(o.length).toBeLessThanOrEqual(OUTLINE_MAX_ITEMS);
    expect(o.every((x) => x.id in SECTION_TITLES)).toBe(true);
    // The old per-item loop rescanned the text for each id; one pass takes a few ms here.
    expect(ms).toBeLessThan(500);
  });
  it("handles long runs of the same heading without quadratic scanning", () => {
    const t = Array.from({ length: 30_000 }, () => "Item 1A. Risk Factors\nshort").join("\n") + "\nItem 7. MD&A\nend";
    const t0 = performance.now();
    const o = outlineSections(t, "10-K");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(o.map((x) => x.id)).toEqual(["1A", "7"]);
    expect(o[0]).toMatchObject({ offset: 0 });
    expect(extractSection(t, "1A")!.start).toBe(0);
  });
});

describe("tests/fixtures/tool-outputs.json", () => {
  it("uses synthetic names for Form 4 reporters", () => {
    const real = JSON.parse(readFileSync(new URL("./fixtures/tool-outputs.json", import.meta.url), "utf8")) as Record<string, { filings?: { reporter?: string }[] }[]>;
    const reporters = (real.get_insider_trades ?? []).flatMap((r) => (r.filings ?? []).map((f) => f.reporter));
    expect(reporters.length).toBeGreaterThan(0);
    for (const r of reporters) expect(["Example Jane", "Sample John"]).toContain(r);
  });
});

const fakeTool = (result: unknown): ToolDef =>
  ({
    name: "fake_tool",
    title: "Fake",
    description: "test",
    inputSchema: z.object({}),
    outputSchema: z.object({ count: z.number() }),
    run: async () => result,
  }) as unknown as ToolDef;

describe("runTool", () => {
  it("turns an output-schema mismatch into a logged tool error instead of a protocol error", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const r = await runTool(fakeTool({ count: "Jane Example" }), {}, "stdio");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const body = JSON.parse((r.content[0] as { text: string }).text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toMatch(/output schema \(ref \w+\)/);
    const log = writes.find((w) => w.includes("output-schema"));
    expect(log).toContain("count:invalid_type");
    expect(log).not.toContain("Jane Example"); // paths and codes only, never values
  });
  it("reports responseChars including structuredContent", async () => {
    const seen: UsageResult[] = [];
    setUsageHooks({ afterCall: (e) => void seen.push(e) });
    const ok = await runTool(fakeTool({ count: 3 }), {}, "stdio");
    const text = (ok.content[0] as { text: string }).text;
    expect(ok.structuredContent).toEqual({ count: 3 });
    expect(seen[0]!.responseChars).toBe(text.length * 2);
    const noSchema = { ...fakeTool({ count: 3 }), outputSchema: undefined } as unknown as ToolDef;
    await runTool(noSchema, {}, "stdio");
    expect(seen[1]!.responseChars).toBe(text.length);
  });
});
