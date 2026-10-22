import { getJson } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { archiveBase, compact, filingIndexUrl, padCik } from "../core/util.js";

export interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  acceptanceDateTime: string[];
  form: string[];
  items: string[];
  size: number[];
  isXBRL: number[];
  isInlineXBRL: number[];
  primaryDocument: string[];
  primaryDocDescription: string[];
  fileNumber?: string[];
}

interface Address {
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  stateOrCountry?: string | null;
  zipCode?: string | null;
  stateOrCountryDescription?: string | null;
  country?: string | null;
}

export interface Submissions {
  cik: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  ownerOrg?: string;
  name: string;
  tickers: string[];
  exchanges: (string | null)[];
  ein?: string | null;
  lei?: string | null;
  description?: string;
  website?: string;
  investorWebsite?: string;
  category?: string;
  fiscalYearEnd?: string | null;
  stateOfIncorporation?: string;
  stateOfIncorporationDescription?: string;
  addresses?: { mailing?: Address; business?: Address };
  phone?: string | null;
  flags?: string;
  formerNames?: { name: string; from: string; to: string }[];
  insiderTransactionForIssuerExists?: number;
  filings: { recent: RecentFilings; files: { name: string; filingCount: number; filingFrom: string; filingTo: string }[] };
}

export const submissionsUrl = (cik: string | number) => `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;

export async function getSubmissions(cik: string | number): Promise<Submissions> {
  try {
    return await getJson<Submissions>(submissionsUrl(cik), "sec", TTL.submissions);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new ToolError("NOT_FOUND", `No EDGAR submissions for CIK ${padCik(cik)}.`, "Check the CIK with search_company.");
    throw e;
  }
}

async function getHistoryPage(name: string): Promise<RecentFilings> {
  return getJson<RecentFilings>(`https://data.sec.gov/submissions/${name}`, "sec", TTL.submissionsHistory);
}

function fmtAddress(a?: Address): string | undefined {
  if (!a || !a.street1) return undefined;
  return [a.street1, a.street2, a.city, [a.stateOrCountryDescription ?? a.stateOrCountry, a.zipCode].filter(Boolean).join(" "), a.country]
    .filter(Boolean)
    .join(", ");
}

function fmtFye(f?: string | null): string | undefined {
  if (!f || f.length !== 4) return undefined;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = Number(f.slice(0, 2));
  return `${months[m - 1] ?? f.slice(0, 2)} ${Number(f.slice(2))} (${f})`;
}

export function buildProfile(s: Submissions) {
  const r = s.filings.recent;
  const latestByForm = (forms: string[]) => {
    for (let i = 0; i < r.form.length; i++) if (forms.includes(r.form[i]!)) return { form: r.form[i], filed: r.filingDate[i], accession: r.accessionNumber[i] };
    return undefined;
  };
  return compact({
    cik: padCik(s.cik),
    name: s.name,
    tickers: s.tickers,
    exchanges: s.exchanges?.filter(Boolean),
    entity_type: s.entityType,
    category: s.category,
    sic: s.sic,
    sic_description: s.sicDescription,
    industry_office: s.ownerOrg,
    state_of_incorporation: s.stateOfIncorporationDescription || s.stateOfIncorporation,
    fiscal_year_end: fmtFye(s.fiscalYearEnd),
    ein: s.ein && s.ein !== "000000000" ? `${s.ein.slice(0, 2)}-${s.ein.slice(2)}` : undefined,
    lei: s.lei,
    phone: s.phone,
    website: s.website,
    business_address: fmtAddress(s.addresses?.business),
    mailing_address: fmtAddress(s.addresses?.mailing),
    former_names: s.formerNames?.map((f) => ({ name: f.name, from: f.from?.slice(0, 10), to: f.to?.slice(0, 10) })),
    has_insider_filings: s.insiderTransactionForIssuerExists === 1,
    total_filings: r.accessionNumber.length + (s.filings.files ?? []).reduce((a, f) => a + f.filingCount, 0),
    latest_annual_report: latestByForm(["10-K", "20-F", "40-F", "10-K/A"]),
    latest_quarterly_report: latestByForm(["10-Q"]),
    source_url: submissionsUrl(s.cik),
    edgar_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padCik(s.cik)}`,
  });
}

export interface FilingRow {
  form: string;
  accession: string;
  filed: string;
  report_date?: string;
  accepted?: string;
  description?: string;
  items?: string;
  primary_doc?: string;
  url?: string;
  index_url: string;
  xbrl?: boolean;
  size?: number;
}

export function rowsFromColumns(cik: string | number, r: RecentFilings): FilingRow[] {
  const out: FilingRow[] = [];
  const n = r.accessionNumber.length;
  for (let i = 0; i < n; i++) {
    const acc = r.accessionNumber[i]!;
    const doc = r.primaryDocument?.[i] || undefined;
    out.push({
      form: r.form[i]!,
      accession: acc,
      filed: r.filingDate[i]!,
      report_date: r.reportDate?.[i] || undefined,
      accepted: r.acceptanceDateTime?.[i] || undefined,
      description: r.primaryDocDescription?.[i] || undefined,
      items: r.items?.[i] || undefined,
      primary_doc: doc,
      url: doc ? `${archiveBase(cik, acc)}/${doc}` : undefined,
      index_url: filingIndexUrl(cik, acc),
      xbrl: r.isXBRL?.[i] ? true : undefined,
      size: r.size?.[i],
    });
  }
  return out;
}

export interface FilingFilter {
  forms?: string[];
  includeAmendments?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

export function matchesFilter(f: FilingRow, flt: FilingFilter): boolean {
  if (flt.forms && flt.forms.length) {
    const want = flt.forms.map((x) => x.toUpperCase().trim());
    const form = f.form.toUpperCase();
    const base = form.endsWith("/A") ? form.slice(0, -2) : form;
    const ok = want.includes(form) || (flt.includeAmendments !== false && want.includes(base));
    if (!ok) return false;
  }
  if (flt.dateFrom && f.filed < flt.dateFrom) return false;
  if (flt.dateTo && f.filed > flt.dateTo) return false;
  return true;
}

/**
 * Iterate filings newest-first, transparently loading older-history pages
 * (submissions "files") only when the caller needs more rows or older dates.
 */
export async function listFilings(
  cik: string | number,
  flt: FilingFilter,
  limit: number,
  offset = 0,
): Promise<{ name: string; cik: string; filings: FilingRow[]; has_more: boolean; scanned_history_pages: number }> {
  const s = await getSubmissions(cik);
  const need = offset + limit + 1;
  const matched: FilingRow[] = [];
  let pages = 0;
  const consume = (rows: FilingRow[]) => {
    for (const r of rows) if (matchesFilter(r, flt)) matched.push(r);
  };
  consume(rowsFromColumns(cik, s.filings.recent));
  const files = [...(s.filings.files ?? [])].sort((a, b) => (a.filingTo < b.filingTo ? 1 : -1));
  for (const f of files) {
    if (matched.length >= need) break;
    if (flt.dateFrom && f.filingTo < flt.dateFrom) continue;
    if (flt.dateTo && f.filingFrom > flt.dateTo) continue;
    if (pages >= LIST_MAX_HISTORY_PAGES) break; // safety bound (cost weights in core/quota.ts assume this)
    const page = await getHistoryPage(f.name);
    pages++;
    consume(rowsFromColumns(cik, page));
  }
  matched.sort((a, b) => (a.filed < b.filed ? 1 : a.filed > b.filed ? -1 : 0));
  return {
    name: s.name,
    cik: padCik(s.cik),
    filings: matched.slice(offset, offset + limit),
    has_more: matched.length > offset + limit,
    scanned_history_pages: pages,
  };
}

/** Max older-history pages scanned by findFiling (each is one SEC request). */
export const FIND_FILING_MAX_PAGES = 4;
/** Max older-history pages scanned when listing filings. */
export const LIST_MAX_HISTORY_PAGES = 4;

/** Find a single filing by accession (searching recent + up to FIND_FILING_MAX_PAGES history pages). */
export async function findFiling(cik: string | number, accession: string): Promise<FilingRow | null> {
  const s = await getSubmissions(cik);
  const hit = rowsFromColumns(cik, s.filings.recent).find((r) => r.accession === accession);
  if (hit) return hit;
  // Accession numbers embed the filing year (NNNNNNNNNN-YY-NNNNNN); scan pages covering it first.
  const yy = Number(accession.split("-")[1]);
  const year = Number.isFinite(yy) ? (yy > 90 ? 1900 + yy : 2000 + yy) : undefined;
  const files = [...(s.filings.files ?? [])].sort((a, b) => {
    if (!year) return 0;
    const covers = (f: { filingFrom: string; filingTo: string }) => Number(f.filingFrom.slice(0, 4)) <= year + 1 && Number(f.filingTo.slice(0, 4)) >= year - 1;
    return Number(covers(b)) - Number(covers(a));
  });
  for (const f of files.slice(0, FIND_FILING_MAX_PAGES)) {
    const page = await getHistoryPage(f.name);
    const h = rowsFromColumns(cik, page).find((r) => r.accession === accession);
    if (h) return h;
  }
  return null;
}
