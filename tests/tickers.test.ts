import { describe, expect, it } from "vitest";
import { coreTokens, dice, parseTickerExchangeFile, rankCompanies, scoreMatch, type TickerRow } from "../src/sec/tickers.js";

const rows: TickerRow[] = parseTickerExchangeFile({
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1067983, "BERKSHIRE HATHAWAY INC", "BRK-B", "NYSE"],
    [1067983, "BERKSHIRE HATHAWAY INC", "BRK-A", "NYSE"],
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [1318605, "Tesla, Inc.", "TSLA", "Nasdaq"],
    [1, "APPLE HOSPITALITY REIT, INC.", "APLE", "NYSE"],
    [2, "Applied Materials Inc", "AMAT", "Nasdaq"],
  ],
});

describe("ticker search", () => {
  it("parses the exchange file", () => {
    expect(rows[0]).toEqual({ cik: 320193, name: "Apple Inc.", ticker: "AAPL", exchange: "Nasdaq" });
  });
  it("exact ticker scores 100", () => {
    expect(scoreMatch("aapl", rows[0]!)).toBe(100);
    expect(scoreMatch("BRK.B", rows[1]!)).toBe(100);
  });
  it("strips corporate suffixes", () => {
    expect(coreTokens("The Apple Inc.")).toEqual(["APPLE"]);
    expect(coreTokens("Tesla, Inc.")).toEqual(["TESLA"]);
  });
  it("ranks name matches and merges share classes", () => {
    const r = rankCompanies(rows, "berkshire", 5);
    expect(r[0]!.cik).toBe("0001067983");
    expect(r[0]!.tickers.sort()).toEqual(["BRK-A", "BRK-B"]);
    const a = rankCompanies(rows, "apple", 5);
    expect(a[0]!.name).toBe("Apple Inc.");
    expect(a.map((x) => x.name)).toContain("APPLE HOSPITALITY REIT, INC.");
  });
  it("is tolerant to typos", () => {
    expect(rankCompanies(rows, "microsft", 3)[0]?.cik).toBe("0000789019");
  });
  it("dice similarity", () => {
    expect(dice("NIGHT", "NACHT")).toBeCloseTo(0.25);
    expect(dice("ABC", "ABC")).toBe(1);
  });
});
