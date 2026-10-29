import { describe, expect, it } from "vitest";
import { allowedEdits, canonicalName, coreTokens, editDistance, fuzzyTokenDistance, nameTokens, normalizeName } from "../src/core/names.js";

describe("name normalisation", () => {
  it("normalises case, punctuation, & and single-letter runs", () => {
    expect(normalizeName("Tiffany & Co.")).toBe("TIFFANY AND CO");
    expect(normalizeName("Acme, L.L.C.")).toBe("ACME LLC");
    expect(normalizeName("J.P. Morgan Chase & Co")).toBe("JP MORGAN CHASE AND CO");
    expect(normalizeName("AT&T Inc.")).toBe("AT AND T INC");
  });
  it("ignores legal suffixes and fillers in core tokens", () => {
    for (const n of ["Johnson & Johnson", "JOHNSON AND JOHNSON", "johnson and johnson inc."]) expect(coreTokens(n)).toEqual(["JOHNSON", "JOHNSON"]);
    expect(coreTokens("The Coca-Cola Company")).toEqual(["COCA", "COLA"]);
    expect(coreTokens("Holdings Inc")).toEqual(["HOLDINGS", "INC"]); // never empty
  });
  it("canonicalises suffix spellings", () => {
    expect(canonicalName("Tiffany and Company")).toBe(canonicalName("TIFFANY & CO."));
    expect(canonicalName("Acme Incorporated")).toBe(canonicalName("ACME, INC."));
    expect(canonicalName("Acme Corporation")).toBe("ACME CORP");
  });
  it("keeps single letters apart for LIKE patterns", () => {
    expect(nameTokens("J.P. Morgan & Co")).toEqual(["J", "P", "MORGAN", "AND", "CO"]);
    expect(nameTokens("O'Reilly 100%_x")).toEqual(["O", "REILLY", "100", "X"]);
  });
});

describe("bounded edit distance", () => {
  it("counts substitutions, insertions, deletions and transpositions", () => {
    expect(editDistance("MICROSOFT", "MICROSOFT")).toBe(0);
    expect(editDistance("MICROSFOT", "MICROSOFT")).toBe(1); // transposition
    expect(editDistance("TESLLA", "TESLA")).toBe(1);
    expect(editDistance("NVIDAI", "NVIDIA")).toBe(1);
    expect(editDistance("ABC", "XYZ", 1)).toBe(2); // capped at max+1
    expect(editDistance("A".repeat(65), "A".repeat(65) + "B", 5)).toBe(6); // long inputs refused
  });
  it("tolerates more edits for longer tokens only", () => {
    expect(allowedEdits(3)).toBe(0);
    expect(allowedEdits(5)).toBe(1);
    expect(allowedEdits(9)).toBe(2);
  });
  it("matches typo'd tokens but not unrelated words", () => {
    expect(fuzzyTokenDistance(["BERKSHRE", "HATHAWAY"], ["BERKSHIRE", "HATHAWAY"])).toBe(1);
    expect(fuzzyTokenDistance(["MICROS"], ["MICROSOFT"])).toBe(0); // prefix
    expect(fuzzyTokenDistance(["MICROSF"], ["MICROSOFT"])).toBe(1); // typo in a prefix
    expect(fuzzyTokenDistance(["ZZQXJ"], ["ARAMARK"])).toBeUndefined();
    expect(fuzzyTokenDistance(["IBM"], ["IBX"])).toBeUndefined(); // short tokens must be exact
  });
});
