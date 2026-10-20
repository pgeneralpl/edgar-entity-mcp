import { describe, expect, it } from "vitest";
import { accessionNoDashes, archiveBase, compact, filingIndexUrl, isoDate, normalizeAccession, padCik } from "../src/core/util.js";
import { toToolError, HttpError, ToolError } from "../src/core/errors.js";

describe("util", () => {
  it("pads CIKs", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("CIK0000320193")).toBe("0000320193");
    expect(() => padCik("abc")).toThrow(ToolError);
  });
  it("normalizes accession numbers", () => {
    expect(normalizeAccession("000032019324000123")).toBe("0000320193-24-000123");
    expect(accessionNoDashes("0000320193-24-000123")).toBe("000032019324000123");
    expect(() => normalizeAccession("123")).toThrow(/18 digits/);
  });
  it("builds archive URLs", () => {
    expect(archiveBase("0000320193", "0000320193-24-000123")).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019324000123");
    expect(filingIndexUrl(320193, "0000320193-24-000123")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/0000320193-24-000123-index.htm",
    );
  });
  it("compacts nulls and empties", () => {
    expect(compact({ a: 1, b: null, c: "", d: { e: undefined }, f: [{ g: null, h: 2 }] })).toEqual({ a: 1, f: [{ h: 2 }] });
  });
  it("parses ISO dates and drops placeholders", () => {
    expect(isoDate("2021-06-21T00:00:00.000")).toBe("2021-06-21");
    expect(isoDate("0001-01-01T00:00:00.000")).toBeUndefined();
    expect(isoDate(undefined)).toBeUndefined();
  });
  it("maps HTTP errors to tool errors", () => {
    expect(toToolError(new HttpError(404, "https://data.sec.gov/x")).code).toBe("NOT_FOUND");
    expect(toToolError(new HttpError(403, "https://www.sec.gov/x")).hint).toMatch(/SEC_USER_AGENT/);
    expect(toToolError(new HttpError(429, "https://data.ny.gov/x")).code).toBe("RATE_LIMITED");
  });
});
