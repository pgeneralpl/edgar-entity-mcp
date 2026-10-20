import { ToolError } from "./errors.js";

export function padCik(cik: string | number): string {
  const s = String(cik).replace(/^CIK/i, "").replace(/\D/g, "");
  if (!s) throw new ToolError("INVALID_INPUT", `Invalid CIK: ${cik}`);
  return s.padStart(10, "0");
}

export function cikInt(cik: string | number): number {
  return Number(padCik(cik));
}

/** "0000320193-24-000123" -> "000032019324000123" */
export function accessionNoDashes(acc: string): string {
  return acc.replace(/-/g, "");
}

/** Normalise "000032019324000123" or "0000320193-24-000123" to dashed form. */
export function normalizeAccession(acc: string): string {
  const d = acc.replace(/\D/g, "");
  if (d.length !== 18) throw new ToolError("INVALID_INPUT", `Invalid accession number: ${acc} (expected 18 digits, e.g. 0000320193-24-000123)`);
  return `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
}

export function archiveBase(cik: string | number, acc: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cikInt(cik)}/${accessionNoDashes(normalizeAccession(acc))}`;
}

export function filingIndexUrl(cik: string | number, acc: string): string {
  const a = normalizeAccession(acc);
  return `${archiveBase(cik, a)}/${a}-index.htm`;
}

export function clamp(n: number | undefined, min: number, max: number, dflt: number): number {
  if (n === undefined || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Drop null/undefined/empty-string fields recursively (token efficiency). */
export function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => compact(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null || x === undefined || x === "") continue;
      const c = compact(x);
      if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return v;
}

/** YYYY-MM-DD from various date strings. */
export function isoDate(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return undefined;
  if (m[1] === "0001") return undefined; // placeholder dates used by some registries
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function titleCaseWords(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
