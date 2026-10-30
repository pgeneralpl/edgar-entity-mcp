/**
 * Company-name normalisation and cheap fuzzy matching shared by search_company (SEC ticker list)
 * and lookup_business_entity (state registries). Pure functions, no I/O.
 */

/** Legal-form and filler words ignored when comparing names ("Apple Inc." == "APPLE INC" == "Apple"). */
export const SUFFIXES = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "COS", "COMPANIES", "LTD", "LIMITED", "PLC", "LLC", "LP", "LLP", "PLLC",
  "PC", "PBC", "HOLDINGS", "HOLDING", "GROUP", "SA", "NV", "AG", "SE", "THE", "DE", "NEW", "CLASS", "CL", "ADR", "TRUST",
]);

/** Words dropped from match keys only ("&" is normalised to AND first). */
const FILLER = new Set(["AND", "THE", "OF"]);

/** Canonical spelling of legal suffixes, used for "exact" matching that ignores INC vs INCORPORATED. */
export const CANONICAL_SUFFIX: Record<string, string> = {
  INCORPORATED: "INC",
  CORPORATION: "CORP",
  COMPANY: "CO",
  LIMITED: "LTD",
  COMPANIES: "COS",
};

/** Upper-case, "&" -> AND, punctuation -> space, single-letter runs collapsed (L.L.C. -> LLC, J.P. -> JP). */
export function normalizeName(s: string): string {
  const spaced = s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,'’()/\\]/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Collapse runs of 2+ single-letter tokens: "L L C" -> "LLC", "J P MORGAN" -> "JP MORGAN". "AT AND T" is untouched.
  return spaced.replace(/\b([A-Z0-9])((?: [A-Z0-9]\b)+)/g, (m) => m.replace(/ /g, ""));
}

/** Distinctive tokens: normalised name without legal suffixes and fillers (falls back to all tokens). */
export function coreTokens(s: string): string[] {
  const t = normalizeName(s).split(" ").filter(Boolean);
  const core = t.filter((w) => !SUFFIXES.has(w) && !FILLER.has(w));
  if (core.length) return core;
  const noFiller = t.filter((w) => !FILLER.has(w));
  return noFiller.length ? noFiller : t;
}

/** Full normalised name with canonical suffix spellings ("Tiffany & Company" -> "TIFFANY AND CO"). */
export function canonicalName(s: string): string {
  return normalizeName(s)
    .split(" ")
    .filter(Boolean)
    .map((w) => CANONICAL_SUFFIX[w] ?? w)
    .join(" ");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const x = s.replace(/ /g, "");
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams (0..1). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return (2 * inter) / total;
}

/**
 * Optimal-string-alignment edit distance (Levenshtein + adjacent transposition), bounded:
 * returns max+1 as soon as the distance is known to exceed `max`. Inputs are capped at 64 chars.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (a.length > 64 || b.length > 64) return max + 1;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[n]!, max + 1);
}

/** Edits tolerated for a token of this length: none below 4 chars, 1 up to 6, 2 from 7. */
export function allowedEdits(len: number): number {
  return len < 4 ? 0 : len < 7 ? 1 : 2;
}

/**
 * Typo-tolerant token match: every query token must equal, prefix (>= 3 chars) or be within
 * allowedEdits() of some name token. Returns the total edit distance, or undefined when a token has no match.
 */
export function fuzzyTokenDistance(qTokens: string[], nTokens: string[]): number | undefined {
  let total = 0;
  for (const qt of qTokens) {
    let best = Infinity;
    for (const nt of nTokens) {
      if (nt === qt || (qt.length >= 3 && nt.startsWith(qt))) {
        best = 0;
        break;
      }
      const max = allowedEdits(Math.min(qt.length, nt.length));
      if (max) {
        const d = editDistance(qt, nt, max);
        if (d <= max && d < best) best = d;
      }
      // Typo in a prefix of a longer name token: "microsf" ~ "MICROSOFT".
      const pmax = allowedEdits(qt.length);
      if (pmax && nt.length > qt.length) {
        const d = editDistance(qt, nt.slice(0, qt.length), pmax);
        if (d <= pmax && d < best) best = d;
      }
    }
    if (best === Infinity) return undefined;
    total += best;
  }
  return total;
}

/** Upper-cased A-Z/0-9 tokens without single-letter collapsing ("J.P. Morgan" -> J P MORGAN); "&" -> AND. */
export function nameTokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** True for tokens ignored by coreTokens() (legal suffixes and AND/THE/OF). */
export function isNoiseToken(t: string): boolean {
  return SUFFIXES.has(t) || FILLER.has(t);
}
