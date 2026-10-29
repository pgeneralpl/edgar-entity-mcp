import { stripInvisible as _strip } from "../core/untrusted.js";
import { convert } from "html-to-text";
import { getText, derived, assertSecUrl, validateFilingDocUrl } from "../core/http.js";
import { TTL, getCache } from "../core/cache.js";
import { config } from "../config.js";
import { ToolError } from "../core/errors.js";

/** Remove inline-XBRL hidden header and other non-content blocks before conversion. */
export function preClean(html: string): string {
  return html
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<div[^>]*display:\s*none[^>]*>[\s\S]*?<\/div>/gi, "");
}

export function htmlToText(html: string): string {
  const text = convert(preClean(html), {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "table", format: "dataTable", options: { colSpacing: 2, maxColumnWidth: 60, uppercaseHeaderCells: false } },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
    ],
    limits: { maxInputLength: 16_000_000 },
  });
  return tidy(text);
}

export { stripInvisible } from "../core/untrusted.js";

export function tidy(text: string): string {
  return _strip(text)
    .replace(/\u00a0/g, " ")
    .replace(/^-{10,}$/gm, "---")
    .replace(/\$[ \t]+(?=[\d(])/g, "$")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{3,}/g, "  ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------- 10-K / 10-Q section extraction ----------------

/** Canonical item ids we recognise. */
export const SECTION_TITLES: Record<string, string> = {
  "1": "Business (10-K) / Financial Statements (10-Q Part I)",
  "1A": "Risk Factors",
  "1B": "Unresolved Staff Comments",
  "1C": "Cybersecurity",
  "2": "Properties (10-K) / MD&A (10-Q Part I)",
  "3": "Legal Proceedings (10-K) / Market Risk (10-Q Part I)",
  "4": "Mine Safety Disclosures (10-K) / Controls and Procedures (10-Q Part I)",
  "5": "Market for Registrant's Common Equity",
  "6": "[Reserved] / Exhibits (10-Q)",
  "7": "Management's Discussion and Analysis (MD&A)",
  "7A": "Quantitative and Qualitative Disclosures About Market Risk",
  "8": "Financial Statements and Supplementary Data",
  "9": "Changes in and Disagreements with Accountants",
  "9A": "Controls and Procedures",
  "9B": "Other Information",
  "9C": "Disclosure Regarding Foreign Jurisdictions that Prevent Inspections",
  "10": "Directors, Executive Officers and Corporate Governance",
  "11": "Executive Compensation",
  "12": "Security Ownership of Certain Beneficial Owners and Management",
  "13": "Certain Relationships and Related Transactions",
  "14": "Principal Accountant Fees and Services",
  "15": "Exhibits and Financial Statement Schedules",
  "16": "Form 10-K Summary",
};

export interface Heading {
  item: string;
  pos: number;
}

const HEADING_RE = /^[ \t]*(?:PART\s+[IV]+[\s,.\-–—]*)?ITEM[\s\u00a0]+(\d{1,2}[A-C]?)\s*[.:\-–—]?/gim;

export function findHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(text))) {
    out.push({ item: m[1]!.toUpperCase(), pos: m.index });
  }
  return out;
}

export function normalizeSectionId(s: string): string {
  return s
    .toUpperCase()
    .replace(/^ITEM\s*/, "")
    .replace(/[^0-9A-C]/g, "");
}

/**
 * Longest span per item id, in one pass over the headings: a span runs from a heading to the next
 * heading of a different item (or the end of the text). Filings repeat headings in the table of
 * contents, so every occurrence is considered and the longest span (the real section) wins; ties keep
 * the first. `keep` limits which ids are collected.
 */
function bestSpans(hs: Heading[], textLength: number, keep: (id: string) => boolean): Map<string, { start: number; end: number }> {
  // nextDiff[i]: index of the first heading after i whose item differs from hs[i]'s (hs.length if none).
  const nextDiff = new Array<number>(hs.length);
  for (let i = hs.length - 1; i >= 0; i--) nextDiff[i] = i + 1 < hs.length && hs[i + 1]!.item === hs[i]!.item ? nextDiff[i + 1]! : i + 1;
  const best = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < hs.length; i++) {
    const id = hs[i]!.item;
    if (!keep(id)) continue;
    const start = hs[i]!.pos;
    const end = nextDiff[i]! < hs.length ? hs[nextDiff[i]!]!.pos : textLength;
    const cur = best.get(id);
    if (!cur || end - start > cur.end - cur.start) best.set(id, { start, end });
  }
  return best;
}

/**
 * Extract an item section. Filings repeat headings in the table of contents, so
 * we consider every occurrence and keep the longest span (the real section).
 */
export function extractSection(text: string, section: string): { text: string; start: number; end: number } | undefined {
  const want = normalizeSectionId(section);
  const best = bestSpans(findHeadings(text), text.length, (id) => id === want).get(want);
  if (!best) return undefined;
  return { text: text.slice(best.start, best.end).trim(), start: best.start, end: best.end };
}

export interface OutlineItem {
  id: string;
  title?: string;
  /** Start of the item in the full text (usable as get_filing_document offset). */
  offset: number;
  /** Length of the item in characters (the span extractSection returns for this id). */
  chars: number;
}

const TITLES_10K: Record<string, string> = { "1": "Business", "2": "Properties", "3": "Legal Proceedings", "4": "Mine Safety Disclosures", "6": "[Reserved]" };
/** 10-Q items 1–4 are Part I (Part II repeats the ids; the longer, usually Part I, span is the one kept). */
const TITLES_10Q: Record<string, string> = {
  "1": "Financial Statements",
  "2": "Management's Discussion and Analysis (MD&A)",
  "3": "Quantitative and Qualitative Disclosures About Market Risk",
  "4": "Controls and Procedures",
  "5": "Other Information",
  "6": "Exhibits",
};

/** "10-K" / "10-Q" from a form type, else from the cover page ("FORM 10-K"), else undefined. */
export function detectForm(text: string, form?: string): "10-K" | "10-Q" | undefined {
  const f = (form ?? "").toUpperCase();
  if (/^10-?K/.test(f)) return "10-K";
  if (/^10-?Q/.test(f)) return "10-Q";
  const m = /\bFORM[\s\u00a0]+10-?([KQ])\b/i.exec(text.slice(0, 5000));
  return m ? (m[1]!.toUpperCase() === "K" ? "10-K" : "10-Q") : undefined;
}

/** Item title for the form when known (10-K and 10-Q share ids 1–6 with different meanings). */
export function sectionTitle(id: string, form?: "10-K" | "10-Q"): string | undefined {
  if (form === "10-Q" && TITLES_10Q[id]) return TITLES_10Q[id];
  if (form === "10-K" && TITLES_10K[id]) return TITLES_10K[id];
  return SECTION_TITLES[id];
}

/** Item ids an outline reports (10-K/10-Q items); other "Item NN" matches are ignored. */
const OUTLINE_IDS = new Set(Object.keys(SECTION_TITLES));
/** Upper bound on outline entries (there are fewer known ids; kept as a guard). */
export const OUTLINE_MAX_ITEMS = 30;

/**
 * Each known item once, in document order, with the same span extractSection would pick.
 * One scan of the text and one pass over the headings (not one full extraction per item).
 */
export function outlineSections(text: string, form?: string): OutlineItem[] {
  const f = detectForm(text, form);
  const spans = bestSpans(findHeadings(text), text.length, (id) => OUTLINE_IDS.has(id));
  const out: OutlineItem[] = [];
  for (const [id, sp] of spans) {
    if (out.length >= OUTLINE_MAX_ITEMS) break;
    out.push({ id, title: sectionTitle(id, f), offset: sp.start, chars: sp.end - sp.start });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

export function listSections(text: string): string[] {
  const seen: string[] = [];
  for (const h of findHeadings(text)) if (!seen.includes(h.item)) seen.push(h.item);
  return seen;
}

/** Processed text above this size stays in process memory only (keeps Redis small). */
export const SHARED_TEXT_MAX_CHARS = 256 * 1024;

/**
 * Fetch an SEC document and return clean text.
 * - User-supplied URLs must pass the strict Archives path check (validateFilingDocUrl);
 *   URLs we built ourselves from EDGAR metadata (`trusted`) only need an allowlisted host.
 * - Raw bodies are cached in process memory only; processed text is shared via Redis only when small.
 */
export async function fetchDocumentText(url: string, opts: { trusted?: boolean } = {}): Promise<{ text: string; kind: string; url: string }> {
  const canonical = opts.trusted ? assertSecUrl(url).toString() : validateFilingDocUrl(url);
  const u = new URL(canonical);
  if (/\.pdf$/i.test(u.pathname)) throw new ToolError("UNSUPPORTED", "PDF documents are not supported; open the filing index for HTML/TXT alternatives.");
  const produce = async () => {
    const raw = await getText(canonical, "sec", TTL.filingDoc, { tier: "memory", maxBytes: config().maxDocumentBytes });
    const looksHtml = /\.(x?html?)$/i.test(u.pathname) || /<html|<body|<div|<p[\s>]/i.test(raw.slice(0, 5000));
    if (looksHtml) return { text: htmlToText(raw), kind: "html" };
    if (/\.xml$/i.test(u.pathname)) return { text: _strip(raw), kind: "xml" };
    return { text: tidy(raw), kind: "text" };
  };
  // Memory first (any size); then the shared tier, which only ever holds small processed text.
  const mem = await derived(
    `doctext:${canonical}`,
    TTL.filingDoc,
    async () => {
      const cache = getCache();
      const key = `${config().cachePrefix}doctext-s:${canonical}`;
      const hit = await cache.get(key);
      if (hit) {
        try {
          return JSON.parse(hit) as { text: string; kind: string };
        } catch {
          /* recompute */
        }
      }
      const r = await produce();
      if (r.text.length <= SHARED_TEXT_MAX_CHARS) await cache.set(key, JSON.stringify(r), TTL.filingDocShared);
      return r;
    },
    { tier: "memory" },
  );
  return { ...mem, url: canonical };
}
