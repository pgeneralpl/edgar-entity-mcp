import { getJson, derived } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { padCik } from "../core/util.js";
import { allowedEdits, coreTokens, dice, editDistance, fuzzyTokenDistance } from "../core/names.js";
import { FORMER_NAMES } from "./formerNames.js";

export const TICKERS_EXCHANGE_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

export interface TickerRow {
  cik: number;
  name: string;
  ticker: string;
  exchange: string | null;
}

interface ExchangeFile {
  fields: string[];
  data: [number, string, string, string | null][];
}

export function parseTickerExchangeFile(f: ExchangeFile): TickerRow[] {
  const idx = (n: string) => f.fields.indexOf(n);
  const [ic, iname, it, ie] = [idx("cik"), idx("name"), idx("ticker"), idx("exchange")];
  return f.data.map((r) => ({
    cik: Number(r[ic]),
    name: String(r[iname]),
    ticker: String(r[it]),
    exchange: ie >= 0 && r[ie] != null ? String(r[ie]) : null,
  }));
}

let memo: { at: number; rows: TickerRow[] } | undefined;

export async function loadTickers(): Promise<TickerRow[]> {
  if (memo && Date.now() - memo.at < TTL.tickers * 1000) return memo.rows;
  const f = await getJson<ExchangeFile>(TICKERS_EXCHANGE_URL, "sec", TTL.tickers);
  const rows = parseTickerExchangeFile(f);
  memo = { at: Date.now(), rows };
  return rows;
}

// ---------- fuzzy ranking ----------

export { normalizeName, coreTokens, dice } from "../core/names.js";

/** Minimum score for a row to count as a match (below it, rows only feed "did you mean"). */
export const MATCH_THRESHOLD = 40;

interface Prepared {
  ticker: string; // upper-case
  tNorm: string; // ticker without - and .
  core: string; // core tokens joined by space
  tokens: string[];
  compact: string; // core tokens joined without spaces
}

function prepareName(name: string): Pick<Prepared, "core" | "tokens" | "compact"> {
  const tokens = coreTokens(name);
  return { tokens, core: tokens.join(" "), compact: tokens.join("") };
}

function prepareRow(r: TickerRow): Prepared {
  const ticker = r.ticker.toUpperCase();
  return { ticker, tNorm: ticker.replace(/[-.]/g, ""), ...prepareName(r.name) };
}

// Normalised forms are computed once per loaded ticker list (about 10k rows), not per query.
const prepared = new WeakMap<TickerRow[], Prepared[]>();
function preparedRows(rows: TickerRow[]): Prepared[] {
  let p = prepared.get(rows);
  if (!p) {
    p = rows.map(prepareRow);
    prepared.set(rows, p);
  }
  return p;
}

/** Typo tolerance and did-you-mean run only for queries up to this many characters ... */
export const FUZZY_MAX_CHARS = 64;
/** ... and this many name tokens (bounds the per-row edit-distance work over ~10k rows). */
export const FUZZY_MAX_TOKENS = 8;

interface PreparedQuery {
  qU: string;
  qT: string;
  name: Pick<Prepared, "core" | "tokens" | "compact"> & { fuzzy: boolean };
}

function prepareQuery(query: string, allowFuzzy = true): PreparedQuery {
  const qU = query.trim().toUpperCase();
  const name = prepareName(query);
  const fuzzy = allowFuzzy && qU.length <= FUZZY_MAX_CHARS && name.tokens.length <= FUZZY_MAX_TOKENS;
  return { qU, qT: qU.replace(/[-.\s]/g, ""), name: { ...name, fuzzy } };
}

/** Name-only similarity of a prepared query and a prepared name, 0..97. */
function nameScore(q: PreparedQuery["name"], n: Pick<Prepared, "core" | "tokens" | "compact">): number {
  if (!q.core) return 0;
  if (q.core === n.core) return 97;
  if (q.compact === n.compact) return 96; // "AT&T" vs "ATT", "Coca Cola" vs "Coca-Cola" vs "CocaCola"
  if (n.core.startsWith(q.core + " ")) return 88 - Math.min(10, n.core.length - q.core.length) / 2;
  const allPrefixed = q.tokens.every((qt) => n.tokens.some((nt) => nt.startsWith(qt)));
  if (allPrefixed) {
    const coverage = q.tokens.join("").length / Math.max(1, n.compact.length);
    return 60 + 25 * coverage;
  }
  if (q.compact.length >= 4 && n.compact.startsWith(q.compact)) return 80 - Math.min(10, n.compact.length - q.compact.length) / 2; // "JP Morgan" -> JPMORGAN CHASE
  if (n.core.includes(q.core)) return 55;
  if (!q.fuzzy) return 0; // long query: exact/prefix matching only
  // Typo tolerance (edit distance per token): "Microsfot" -> MICROSOFT, "berkshre hathaway".
  const d = fuzzyTokenDistance(q.tokens, n.tokens);
  if (d !== undefined && d > 0) {
    const coverage = Math.min(1, q.compact.length / Math.max(1, n.compact.length));
    return Math.min(78, 50 + 25 * coverage - 6 * d);
  }
  const dCompact = q.compact.length >= 5 ? editDistance(q.compact, n.compact, allowedEdits(q.compact.length)) : Infinity;
  if (dCompact <= allowedEdits(q.compact.length)) return Math.min(78, 72 - 6 * dCompact); // "micro sfot"
  return 55 * dice(q.core, n.core);
}

function scorePrepared(q: PreparedQuery, p: Prepared): number {
  let best = 0;
  // Ticker matching (tickers like BRK-B also accept BRK.B / BRKB)
  if (q.qU === p.ticker || (q.qT.length > 0 && q.qT === p.tNorm)) best = 100;
  else if (q.qT.length >= 2 && p.tNorm.startsWith(q.qT) && q.qT.length >= p.tNorm.length - 1) best = 70;
  best = Math.max(best, nameScore(q.name, p));
  return Math.round(best * 10) / 10;
}

/** Score 0..100 for how well `row` matches `query`. */
export function scoreMatch(query: string, row: TickerRow): number {
  return scorePrepared(prepareQuery(query), prepareRow(row));
}

export interface CompanyMatch {
  cik: string;
  name: string;
  tickers: string[];
  exchange: string | null;
  score: number;
  /** Set when the match came from a well-known former/predecessor name. */
  matched_former_name?: string;
}

const preparedFormer = FORMER_NAMES.map((f) => ({ ...f, p: prepareName(f.name) }));


/**
 * Search the SEC ticker list. Rows sharing a CIK (multiple share classes) are merged.
 * `fuzzy: false` keeps only ticker, exact-name and prefix/substring matches (no typo ranking).
 */
export function rankCompanies(rows: TickerRow[], query: string, limit: number, threshold = MATCH_THRESHOLD, opts: { fuzzy?: boolean } = {}): CompanyMatch[] {
  const q = prepareQuery(query, opts.fuzzy ?? true);
  const pr = preparedRows(rows);
  const byCik = new Map<number, CompanyMatch>();
  const add = (r: TickerRow, s: number, former?: string) => {
    const cur = byCik.get(r.cik);
    if (!cur) byCik.set(r.cik, { cik: padCik(r.cik), name: r.name, tickers: [r.ticker], exchange: r.exchange, score: s, ...(former ? { matched_former_name: former } : {}) });
    else {
      if (!cur.tickers.includes(r.ticker)) cur.tickers.push(r.ticker);
      if (s > cur.score) {
        cur.score = s;
        if (former) cur.matched_former_name = former;
        else delete cur.matched_former_name;
      }
    }
  };
  for (let i = 0; i < rows.length; i++) {
    const s = scorePrepared(q, pr[i]!);
    if (s >= threshold) add(rows[i]!, s);
  }
  // Former / predecessor names: scored like names, slightly below an equal current-name match.
  for (const f of preparedFormer) {
    const s = Math.round(nameScore(q.name, f.p) * 0.95 * 10) / 10;
    if (s < Math.max(threshold, 60)) continue;
    for (const r of rows) if (r.cik === f.cik) add(r, s, f.name);
  }
  // Small boost for listed on major exchanges to break ties
  const ex = (m: CompanyMatch) => (m.exchange === "NYSE" || m.exchange === "Nasdaq" ? 0.5 : 0);
  return [...byCik.values()].sort((a, b) => b.score + ex(b) - (a.score + ex(a)) || a.name.length - b.name.length).slice(0, limit);
}

export interface Suggestion {
  cik: string;
  name: string;
  tickers: string[];
}

/**
 * "Did you mean" candidates for a query with no match: looser name similarity plus one-edit ticker
 * typos ("APPL" -> AAPL). Uses only the cached ticker list.
 */
export function suggestCompanies(rows: TickerRow[], query: string, limit = 5): Suggestion[] {
  const q = prepareQuery(query);
  if (!q.name.fuzzy) return []; // long queries get no suggestions (CPU bound)
  const pr = preparedRows(rows);
  const scored = new Map<number, { s: number; m: Suggestion }>();
  for (let i = 0; i < rows.length; i++) {
    const p = pr[i]!;
    let s = q.name.core ? dice(q.name.compact, p.compact) : 0;
    if (q.qT.length >= 3 && q.qT.length <= 6 && editDistance(q.qT, p.tNorm, 1) <= 1) s = Math.max(s, 0.6);
    if (s < 0.35) continue;
    const r = rows[i]!;
    const cur = scored.get(r.cik);
    if (!cur) scored.set(r.cik, { s, m: { cik: padCik(r.cik), name: r.name, tickers: [r.ticker] } });
    else {
      if (!cur.m.tickers.includes(r.ticker)) cur.m.tickers.push(r.ticker);
      cur.s = Math.max(cur.s, s);
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.s - a.s || a.m.name.length - b.m.name.length)
    .slice(0, limit)
    .map((x) => x.m);
}

export async function searchCompanies(query: string, limit = 10): Promise<CompanyMatch[]> {
  const rows = await loadTickers();
  return rankCompanies(rows, query, limit);
}

export async function suggestCompaniesFor(query: string, limit = 5): Promise<Suggestion[]> {
  return suggestCompanies(await loadTickers(), query, limit);
}

/** EDGAR company search (current and former names, incl. filers without a ticker): a link, not a call. */
export function edgarCompanySearchUrl(query: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&owner=include&company=${encodeURIComponent(query.trim().slice(0, 100))}`;
}

export const NOT_LISTED_HINT =
  "Only SEC registrants with a listed ticker are searched here. For a private or non-SEC company (LLC, subsidiary, local business) use lookup_business_entity (state registries); for an SEC filer without a ticker pass its CIK, or open edgar_company_search_url (EDGAR search over current and former names).";

export interface ResolvedCompany {
  cik: string; // 10-digit
  name?: string;
  tickers?: string[];
}

/**
 * Resolve a user-supplied company reference (CIK, ticker, or name) to a CIK.
 * Digits are treated as CIK; otherwise exact ticker, then confident name match.
 * `fuzzy: false` skips typo-tolerant ranking and did-you-mean (bulk callers: compare_companies).
 */
export async function resolveCompany(input: string, opts: { suggest?: boolean; fuzzy?: boolean } = {}): Promise<ResolvedCompany> {
  const fuzzy = opts.fuzzy ?? true;
  const suggest = fuzzy && (opts.suggest ?? true);
  const q = input.trim();
  if (!q) throw new ToolError("INVALID_INPUT", "company is required (ticker, CIK, or company name)");
  if (/^(CIK)?\d{1,10}$/i.test(q)) return { cik: padCik(q) };
  // Separate key without suggestions so concurrent deduped calls never share the other variant's error.
  const variant = fuzzy ? (suggest ? "" : "nosuggest:") : "exact:";
  return derived(`resolve:${variant}${q.toUpperCase()}`, TTL.tickers, async () => {
    const rows = await loadTickers();
    const matches = rankCompanies(rows, q, 5, MATCH_THRESHOLD, { fuzzy });
    const top = matches[0];
    if (!top)
      throw new ToolError("NOT_FOUND", `No SEC registrant matches "${q}".`, NOT_LISTED_HINT, {
        did_you_mean: suggest ? suggestCompanies(rows, q, 5) : undefined,
        edgar_company_search_url: edgarCompanySearchUrl(q),
      });
    const second = matches[1];
    const confident = top.score >= 95 || (top.score >= 80 && (!second || top.score - second.score >= 5));
    if (!confident)
      throw new ToolError(
        "AMBIGUOUS",
        second ? `"${q}" is ambiguous.` : `"${q}" is not an exact match (did you mean ${top.name}?).`,
        "Call again with one of these CIKs or tickers.",
        { candidates: matches.map((m) => ({ cik: m.cik, name: m.name, tickers: m.tickers, ...(m.matched_former_name ? { matched_former_name: m.matched_former_name } : {}) })) },
      );
    return { cik: top.cik, name: top.name, tickers: top.tickers };
  }, { tier: "memory" }); // arbitrary user strings: never create Redis keys for them
}
