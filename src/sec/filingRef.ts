import { ToolError } from "../core/errors.js";
import { validateFilingDocUrl } from "../core/http.js";
import { padCik } from "../core/util.js";

/**
 * Input normalisation for get_filing_document.
 *
 * Agents identify a filing in many ways: a dashed or undashed accession number, a document URL, the
 * filing index page (`<accession>-index.htm`), the filing folder, the complete submission `.txt`, the
 * inline XBRL viewer link, with or without `https://` / `www.`. Everything is parsed here into either
 *   - a document inside a filing folder (fetched directly, after the strict `validateFilingDocUrl`), or
 *   - a filing (CIK? + accession) whose primary document is looked up in EDGAR submissions.
 *
 * SSRF: a user-supplied URL is never fetched as given. Only sec.gov hosts are parsed, and the URL that
 * is fetched is rebuilt from the validated digits / file name as https://www.sec.gov/Archives/... and
 * then passes the unchanged strict gate in core/http.ts.
 */

export const FILING_INPUT_EXAMPLE = '{"company":"AAPL","accession":"0000320193-24-000123","mode":"outline"}';

export const FILING_INPUT_HINT =
  "Accepted inputs: (1) company (ticker, name or CIK such as 320193 / 0000320193) + accession, dashed 0000320193-24-000123 or 18 digits 000032019324000123; " +
  "(2) url of an EDGAR document or filing on www.sec.gov: https://www.sec.gov/Archives/edgar/data/<CIK>/<18-digit accession>/<file>, " +
  "the filing index .../<accession>-index.htm, the filing folder .../<CIK>/<18-digit accession>/ or the inline XBRL viewer link https://www.sec.gov/ix?doc=/Archives/...; " +
  "(3) cik + accession, or accession alone (works when the company filed it itself). " +
  `Get accession numbers and URLs from list_filings. Example: ${FILING_INPUT_EXAMPLE}`;

/** A parsed get_filing_document target. */
export type FilingTarget =
  /** A specific document; `url` is canonical and already passed validateFilingDocUrl. */
  | { kind: "document"; url: string; cik: string; accession: string }
  /** A whole filing; its primary document is looked up. `cik` is set when the input carried one. */
  | { kind: "filing"; accession: string; cik?: string };

const invalid = (message: string) => new ToolError("INVALID_INPUT", message, FILING_INPUT_HINT);

const ACCESSION_RE = /^(\d{10})-?(\d{2})-?(\d{6})$/;

/** "0000320193-24-000123" | "000032019324000123" (surrounding spaces ignored) → dashed form, else undefined. */
export function parseAccession(input: string): string | undefined {
  const m = ACCESSION_RE.exec(input.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Normalise a CIK given as "320193", "0000320193", "CIK0000320193" or a number. */
export function parseCik(input: string | number): string | undefined {
  const s = String(input).trim();
  if (!/^(CIK)?\s*\d{1,10}$/i.test(s)) return undefined;
  const cik = padCik(s);
  return /^0+$/.test(cik) ? undefined : cik;
}

const dashed = (acc18: string) => `${acc18.slice(0, 10)}-${acc18.slice(10, 12)}-${acc18.slice(12)}`;

/** Does this string look like a URL (rather than an accession number)? */
export function looksLikeUrl(input: string): boolean {
  return /^\s*(https?:\/\/|(www\.)?sec\.gov\/|\/?Archives\/)/i.test(input);
}

/**
 * Parse a sec.gov URL into a filing target. Accepts http/https, sec.gov or www.sec.gov, a missing
 * scheme, the /ix?doc= and /cgi-bin/viewer?doc= wrappers, trailing slashes, and query/fragment
 * (dropped). Rejects every other host, credentials and non-default ports.
 */
export function parseFilingUrl(input: string): FilingTarget {
  let raw = input.trim();
  if (/^\/?Archives\//i.test(raw)) raw = `https://www.sec.gov/${raw.replace(/^\//, "")}`;
  else if (/^(www\.)?sec\.gov\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalid("url is not a valid URL.");
  }
  const host = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || (host !== "www.sec.gov" && host !== "sec.gov") || u.username || u.password || (u.port && u.port !== "443" && u.port !== "80"))
    throw invalid("url must point to www.sec.gov (EDGAR Archives); other hosts are never fetched.");
  // Inline XBRL viewer: https://www.sec.gov/ix?doc=/Archives/... (the doc path is re-parsed on www.sec.gov).
  if (/^\/(cgi-bin\/viewer|ix)\/?$/i.test(u.pathname)) {
    const doc = u.searchParams.get("doc");
    if (!doc || !doc.startsWith("/")) throw invalid("The inline XBRL viewer url has no doc=/Archives/... parameter.");
    try {
      u = new URL(doc, "https://www.sec.gov");
    } catch {
      throw invalid("url is not a valid URL.");
    }
    if (u.hostname !== "www.sec.gov") throw invalid("url must point to www.sec.gov (EDGAR Archives); other hosts are never fetched.");
  }
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    throw invalid("url path is not valid.");
  }
  if (path.includes("..") || path.includes("\\")) throw invalid("url path is not valid.");
  const m = /^\/Archives\/edgar\/data\/(\d{1,10})\/(.*)$/i.exec(path);
  if (!m) throw invalid("url must be an EDGAR Archives URL: https://www.sec.gov/Archives/edgar/data/<CIK>/<18-digit accession>/<file>.");
  const cik = parseCik(m[1]!);
  if (!cik) throw invalid("url has an invalid CIK.");
  const rest = m[2]!.replace(/\/+$/, "");

  // <acc18>[/<file>]
  const folder = /^(\d{18})(?:\/([^/]+))?$/.exec(rest);
  if (folder) {
    const accession = dashed(folder[1]!);
    const file = folder[2];
    if (!file || isFilingLevelFile(file, accession)) return { kind: "filing", cik, accession };
    if (!/^[\w.-]{1,200}$/.test(file)) throw invalid("url file name is not valid.");
    const url = validateFilingDocUrl(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${folder[1]}/${file}`);
    return { kind: "document", url, cik, accession };
  }
  // <acc-dashed>.txt or <acc-dashed>-index.htm(l) directly under the CIK folder (older link style).
  const flat = /^(\d{10}-\d{2}-\d{6})(?:\.txt|-index\.html?|-index-headers\.html?)$/i.exec(rest);
  if (flat) return { kind: "filing", cik, accession: flat[1]! };
  // <acc-dashed>/... (folder named with dashes, as some agents write it)
  const dashedFolder = /^(\d{10}-\d{2}-\d{6})(?:\/([^/]+))?$/.exec(rest);
  if (dashedFolder) {
    const acc18 = dashedFolder[1]!.replace(/-/g, "");
    const file = dashedFolder[2];
    if (!file || isFilingLevelFile(file, dashedFolder[1]!)) return { kind: "filing", cik, accession: dashedFolder[1]! };
    if (!/^[\w.-]{1,200}$/.test(file)) throw invalid("url file name is not valid.");
    const url = validateFilingDocUrl(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc18}/${file}`);
    return { kind: "document", url, cik, accession: dashedFolder[1]! };
  }
  throw invalid("url must be an EDGAR filing or document URL: https://www.sec.gov/Archives/edgar/data/<CIK>/<18-digit accession>/<file>.");
}

/** Index pages and the complete submission text identify the filing, not a document to read. */
function isFilingLevelFile(file: string, accession: string): boolean {
  const f = file.toLowerCase();
  return f === `${accession}-index.htm` || f === `${accession}-index.html` || f === `${accession}-index-headers.html` || f === `${accession}.txt` || f === "index.json" || f === "index.html" || f === "index.htm" || f === "index.xml";
}

export interface FilingInput {
  url?: string;
  accession?: string;
  company?: string;
  cik?: string | number;
}

/**
 * Resolve the get_filing_document identification inputs. Values are routed by their shape, so an
 * accession in `url` or a URL in `accession` still works. Returns the target plus the company to
 * resolve (company wins over cik; a URL's own CIK is used when neither is given).
 */
export function parseFilingInput(a: FilingInput): { target: FilingTarget; company?: string } {
  const url = a.url?.trim() || undefined;
  const acc = a.accession?.trim() || undefined;
  const company = a.company?.trim() || undefined;
  let cik: string | undefined;
  if (a.cik !== undefined && String(a.cik).trim() !== "") {
    cik = parseCik(a.cik);
    if (!cik) throw invalid("cik must be digits, e.g. 320193 or 0000320193.");
  }
  const fromValue = (v: string, field: string): FilingTarget => {
    if (looksLikeUrl(v)) return parseFilingUrl(v);
    const accession = parseAccession(v);
    if (accession) return { kind: "filing", accession };
    throw invalid(
      field === "accession"
        ? "accession must be 18 digits, with or without dashes (0000320193-24-000123 or 000032019324000123), or an EDGAR URL."
        : "url must be an EDGAR URL on www.sec.gov or an accession number.",
    );
  };
  if (!url && !acc) throw invalid("Provide url, or accession (with company or cik when someone else filed it).");
  let target = url ? fromValue(url, "url") : fromValue(acc!, "accession");
  if (url && acc && target.kind === "filing") {
    // Both given: the accession must agree with the one inside the URL.
    const other = fromValue(acc, "accession");
    if (other.accession !== target.accession) throw invalid("url and accession refer to different filings; pass only one of them.");
  }
  if (target.kind === "filing" && !target.cik && cik) target = { ...target, cik };
  return { target, company };
}

/**
 * Quota estimate helper: true when the arguments name one document (fetched directly), so no
 * submissions lookup is needed. Inputs that are rejected locally keep the previous estimate
 * (a url costs the document estimate, anything else the lookup estimate).
 */
export function filingInputIsDocument(a: Record<string, unknown>): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  try {
    const cik = a.cik;
    return parseFilingInput({ url: str(a.url), accession: str(a.accession), company: str(a.company), cik: typeof cik === "string" || typeof cik === "number" ? cik : undefined }).target.kind === "document";
  } catch {
    return typeof a.url === "string" && a.url.trim() !== "";
  }
}
