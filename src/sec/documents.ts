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
 * Extract an item section. Filings repeat headings in the table of contents, so
 * we consider every occurrence and keep the longest span (the real section).
 */
export function extractSection(text: string, section: string): { text: string; start: number } | undefined {
  const want = normalizeSectionId(section);
  const hs = findHeadings(text);
  let best: { start: number; end: number } | undefined;
  for (let i = 0; i < hs.length; i++) {
    if (hs[i]!.item !== want) continue;
    const start = hs[i]!.pos;
    let end = text.length;
    for (let j = i + 1; j < hs.length; j++) {
      if (hs[j]!.item !== want) {
        end = hs[j]!.pos;
        break;
      }
    }
    if (!best || end - start > best.end - best.start) best = { start, end };
  }
  if (!best) return undefined;
  return { text: text.slice(best.start, best.end).trim(), start: best.start };
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
