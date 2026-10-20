import { getJson, derived } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { padCik } from "../core/util.js";

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

const SUFFIXES = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "LLC", "LP", "L P",
  "HOLDINGS", "HOLDING", "GROUP", "SA", "NV", "AG", "SE", "THE", "DE", "NEW", "CLASS", "CL", "ADR", "TRUST",
]);

export function normalizeName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,'’()/\\]/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function coreTokens(s: string): string[] {
  const t = normalizeName(s).split(" ").filter(Boolean);
  const core = t.filter((w) => !SUFFIXES.has(w));
  return core.length ? core : t;
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

/** Score 0..100 for how well `row` matches `query`. */
export function scoreMatch(query: string, row: TickerRow): number {
  const q = query.trim();
  const qU = q.toUpperCase();
  const ticker = row.ticker.toUpperCase();
  let best = 0;
  // Ticker matching (tickers like BRK-B also accept BRK.B / BRKB)
  const tNorm = ticker.replace(/[-.]/g, "");
  const qT = qU.replace(/[-.\s]/g, "");
  if (qU === ticker || (qT.length > 0 && qT === tNorm)) best = 100;
  else if (qT.length >= 2 && tNorm.startsWith(qT) && qT.length >= tNorm.length - 1) best = Math.max(best, 70);

  const qCore = coreTokens(q).join(" ");
  const nCore = coreTokens(row.name).join(" ");
  if (!qCore) return best;
  if (qCore === nCore) best = Math.max(best, 97);
  else if (nCore.startsWith(qCore + " ") ) best = Math.max(best, 88 - Math.min(10, nCore.length - qCore.length) / 2);
  else {
    const qTokens = qCore.split(" ");
    const nTokens = nCore.split(" ");
    const allPrefixed = qTokens.every((qt) => nTokens.some((nt) => nt.startsWith(qt)));
    if (allPrefixed) {
      const coverage = qTokens.join("").length / Math.max(1, nTokens.join("").length);
      best = Math.max(best, 60 + 25 * coverage);
    } else if (nCore.includes(qCore)) best = Math.max(best, 55);
    else best = Math.max(best, Math.round(55 * dice(qCore, nCore)));
  }
  return Math.round(best * 10) / 10;
}

export interface CompanyMatch {
  cik: string;
  name: string;
  tickers: string[];
  exchange: string | null;
  score: number;
}

/** Search the SEC ticker list. Rows sharing a CIK (multiple share classes) are merged. */
export function rankCompanies(rows: TickerRow[], query: string, limit: number): CompanyMatch[] {
  const byCik = new Map<number, CompanyMatch>();
  for (const r of rows) {
    const s = scoreMatch(query, r);
    if (s < 40) continue;
    const cur = byCik.get(r.cik);
    if (!cur) byCik.set(r.cik, { cik: padCik(r.cik), name: r.name, tickers: [r.ticker], exchange: r.exchange, score: s });
    else {
      if (!cur.tickers.includes(r.ticker)) cur.tickers.push(r.ticker);
      cur.score = Math.max(cur.score, s);
    }
  }
  // Small boost for listed on major exchanges to break ties
  const ex = (m: CompanyMatch) => (m.exchange === "NYSE" || m.exchange === "Nasdaq" ? 0.5 : 0);
  return [...byCik.values()]
    .sort((a, b) => b.score + ex(b) - (a.score + ex(a)) || a.name.length - b.name.length)
    .slice(0, limit);
}

export async function searchCompanies(query: string, limit = 10): Promise<CompanyMatch[]> {
  const rows = await loadTickers();
  return rankCompanies(rows, query, limit);
}

export interface ResolvedCompany {
  cik: string; // 10-digit
  name?: string;
  tickers?: string[];
}

/**
 * Resolve a user-supplied company reference (CIK, ticker, or name) to a CIK.
 * Digits are treated as CIK; otherwise exact ticker, then confident name match.
 */
export async function resolveCompany(input: string): Promise<ResolvedCompany> {
  const q = input.trim();
  if (!q) throw new ToolError("INVALID_INPUT", "company is required (ticker, CIK, or company name)");
  if (/^(CIK)?\d{1,10}$/i.test(q)) return { cik: padCik(q) };
  return derived(`resolve:${q.toUpperCase()}`, TTL.tickers, async () => {
    const rows = await loadTickers();
    const matches = rankCompanies(rows, q, 5);
    const top = matches[0];
    if (!top) throw new ToolError("NOT_FOUND", `No SEC registrant matches "${q}".`, "Try search_company with a different spelling, or pass the CIK. Note: only companies with a ticker are in the SEC ticker list; for others pass the CIK directly.");
    const second = matches[1];
    const confident = top.score >= 95 || (top.score >= 80 && (!second || top.score - second.score >= 5));
    if (!confident)
      throw new ToolError("AMBIGUOUS", `"${q}" is ambiguous.`, "Call again with one of these CIKs or tickers.", {
        candidates: matches.map((m) => ({ cik: m.cik, name: m.name, tickers: m.tickers })),
      });
    return { cik: top.cik, name: top.name, tickers: top.tickers };
  });
}
