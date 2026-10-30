import { describe, expect, it } from "vitest";
import { coreTokens, dice, edgarCompanySearchUrl, parseTickerExchangeFile, rankCompanies, scoreMatch, suggestCompanies, type TickerRow } from "../src/sec/tickers.js";

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
    [200406, "JOHNSON & JOHNSON", "JNJ", "NYSE"],
    [1326801, "Meta Platforms, Inc.", "META", "Nasdaq"],
    [21344, "COCA COLA CO", "KO", "NYSE"],
    [1584509, "Aramark", "ARMK", "NYSE"],
  ],
});

const MATCH_THRESHOLD_FOR_TEST = 40;

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
  it("normalises &/and, suffixes, punctuation and case", () => {
    for (const q of ["Johnson and Johnson", "johnson & johnson", "JOHNSON & JOHNSON INC."]) expect(rankCompanies(rows, q, 1)[0]?.name).toBe("JOHNSON & JOHNSON");
    expect(rankCompanies(rows, "Johnson and Johnson", 1)[0]!.score).toBeGreaterThanOrEqual(95);
    expect(rankCompanies(rows, "The Coca-Cola Company", 1)[0]!.score).toBeGreaterThanOrEqual(95);
    expect(rankCompanies(rows, "microsoft corporation", 1)[0]!.score).toBeGreaterThanOrEqual(95);
  });
  it("scores typos below the auto-resolve threshold (80)", () => {
    for (const q of ["Microsfot", "Teslla", "berkshre hathaway"]) {
      const top = rankCompanies(rows, q, 3)[0]!;
      expect(top.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD_FOR_TEST);
      expect(top.score).toBeLessThan(80);
    }
    expect(rankCompanies(rows, "Microsfot", 1)[0]!.tickers).toEqual(["MSFT"]);
    expect(rankCompanies(rows, "zzqxj", 5)).toEqual([]); // no garbage matches
  });
  it("matches curated former names", () => {
    const [m] = rankCompanies(rows, "Facebook", 3);
    expect(m!.tickers).toEqual(["META"]);
    expect(m!.matched_former_name).toBe("Facebook Inc");
    expect(m!.score).toBeGreaterThanOrEqual(80);
    expect(rankCompanies(rows, "Apple Computer", 1)[0]!.matched_former_name).toBe("Apple Computer Inc");
    expect(rankCompanies(rows, "Apple", 1)[0]!.matched_former_name).toBeUndefined();
  });
  it("suggests near misses and links EDGAR full company search", () => {
    const s = suggestCompanies(rows, "Johnsen Johnsen", 3);
    expect(s.map((x) => x.name)).toContain("JOHNSON & JOHNSON");
    expect(suggestCompanies(rows, "qqqqqq", 3)).toEqual([]);
    const u = new URL(edgarCompanySearchUrl("Tiffany & Co" + "x".repeat(300)));
    expect(u.hostname).toBe("www.sec.gov");
    expect(u.searchParams.get("company")!.length).toBeLessThanOrEqual(100);
  });
});

