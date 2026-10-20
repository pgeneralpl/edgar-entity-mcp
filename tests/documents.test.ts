import { describe, expect, it } from "vitest";
import { extractSection, htmlToText, listSections, normalizeSectionId, preClean } from "../src/sec/documents.js";

const html = `<html><head><style>.x{}</style></head><body>
<ix:header><ix:hidden>secret xbrl</ix:hidden></ix:header>
<p>TABLE OF CONTENTS</p>
<table><tr><td>Item 1.</td><td>Business</td><td>1</td></tr><tr><td>Item 1A.</td><td>Risk Factors</td><td>5</td></tr><tr><td>Item 7.</td><td>MD&amp;A</td><td>20</td></tr></table>
<p style="font-weight:bold">PART I</p>
<p>Item 1. Business</p><p>We make widgets. ${"Widgets are great. ".repeat(30)}</p>
<p>Item 1A. Risk Factors</p><p>${"Competition is intense. ".repeat(40)}</p>
<p>Item 7. Management's Discussion and Analysis</p>
<table><tr><td>Revenue</td><td>$</td><td>1,000</td></tr><tr><td>Net income</td><td>$</td><td>100</td></tr></table>
<p>Item 8. Financial Statements</p><p>See below.</p>
</body></html>`;

describe("filing documents", () => {
  it("removes inline XBRL header and styles", () => {
    expect(preClean(html)).not.toContain("secret xbrl");
    expect(htmlToText(html)).not.toContain("secret xbrl");
  });
  it("keeps table rows readable", () => {
    const t = htmlToText(html);
    expect(t).toMatch(/Revenue\s+\$\s*1,000/);
  });
  it("lists sections", () => {
    expect(listSections(htmlToText(html))).toEqual(["1", "1A", "7", "8"]);
  });
  it("extracts the real section, not the table of contents entry", () => {
    const t = htmlToText(html);
    const s = extractSection(t, "1A")!;
    expect(s.text.startsWith("Item 1A. Risk Factors")).toBe(true);
    expect(s.text).toContain("Competition is intense.");
    expect(s.text).not.toContain("Management's Discussion");
    expect(extractSection(t, "Item 7")!.text).toContain("Revenue");
    expect(extractSection(t, "9A")).toBeUndefined();
  });
  it("normalizes section ids", () => {
    expect(normalizeSectionId("Item 7A.")).toBe("7A");
    expect(normalizeSectionId("1a")).toBe("1A");
  });
});
