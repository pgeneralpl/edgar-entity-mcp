import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { form4XmlUrl, parseForm4, TRANSACTION_CODES } from "../src/sec/insider.js";

const xml = readFileSync(new URL("./fixtures/form4-aapl.xml", import.meta.url), "utf8");

describe("Form 4 parser", () => {
  const p = parseForm4(xml);
  it("parses issuer and reporter", () => {
    expect(p.issuer).toEqual({ cik: "0000320193", name: "Apple Inc.", ticker: "AAPL" });
    expect(p.reporters[0]).toMatchObject({ name: "Borders Ben", roles: ["Officer"], officer_title: "Principal Accounting Officer" });
    expect(p.rule_10b5_1).toBe(true);
  });
  it("parses non-derivative transactions", () => {
    const nd = p.transactions.filter((t) => !t.derivative);
    expect(nd[0]).toMatchObject({ code: "M", shares: 1714, acquired_disposed: "A", shares_owned_after: 40451, ownership: "D", price: undefined });
    expect(nd[1]).toMatchObject({ code: "F", shares: 883, price: 342, value: 301986, acquired_disposed: "D" });
    const sale = nd.find((t) => t.code === "S")!;
    expect(sale.code_meaning).toBe(TRANSACTION_CODES.S);
  });
  it("parses derivative transactions with underlying", () => {
    const d = p.transactions.filter((t) => t.derivative);
    expect(d.length).toBe(4);
    expect(d[0]).toMatchObject({ security: "Restricted Stock Unit", underlying_security: "Common Stock", underlying_shares: 540 });
  });
  it("collects footnotes", () => {
    expect(p.transactions[0]!.footnotes).toEqual(["F1", "F2"]);
    expect(p.footnotes.F4).toMatch(/10b5-1/);
  });
  it("derives raw XML URL from XSL-rendered primary doc", () => {
    expect(
      form4XmlUrl({ form: "4", accession: "0001140361-26-040127", filed: "2026-10-19", primary_doc: "xslF345X06/form4.xml", index_url: "" }, "0000320193"),
    ).toBe("https://www.sec.gov/Archives/edgar/data/320193/000114036126040127/form4.xml");
  });
});
