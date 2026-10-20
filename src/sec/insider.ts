import { XMLParser } from "fast-xml-parser";
import { getText, derived } from "../core/http.js";
import { toToolError } from "../core/errors.js";
import { stripInvisible } from "./documents.js";
import { TTL } from "../core/cache.js";
import { archiveBase, compact } from "../core/util.js";
import { listFilings, type FilingRow } from "./submissions.js";

export const TRANSACTION_CODES: Record<string, string> = {
  P: "Open market or private purchase",
  S: "Open market or private sale",
  A: "Grant or award from company",
  D: "Disposition to the issuer",
  F: "Shares withheld to pay exercise price or taxes",
  I: "Discretionary transaction",
  M: "Exercise or conversion of derivative (exempt)",
  C: "Conversion of derivative security",
  E: "Expiration of short derivative position",
  H: "Expiration of long derivative position",
  O: "Exercise of out-of-the-money derivative",
  X: "Exercise of in-the-money or at-the-money derivative",
  G: "Gift",
  L: "Small acquisition",
  W: "Acquisition or disposition by will or laws of descent",
  Z: "Deposit into or withdrawal from voting trust",
  J: "Other acquisition or disposition",
  K: "Equity swap or similar",
  U: "Disposition due to tender of shares in change of control",
  V: "Transaction voluntarily reported earlier",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    ["reportingOwner", "nonDerivativeTransaction", "derivativeTransaction", "nonDerivativeHolding", "derivativeHolding", "footnote", "footnoteId"].includes(name),
});

type Node = Record<string, unknown> | undefined;

function val(n: unknown): string | undefined {
  if (n === undefined || n === null) return undefined;
  if (typeof n === "string" || typeof n === "number") return String(n).trim() || undefined;
  const v = (n as Record<string, unknown>).value;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return undefined;
  return String(v).trim() || undefined;
}
function numVal(n: unknown): number | undefined {
  const s = val(n);
  if (s === undefined) return undefined;
  const x = Number(s.replace(/,/g, ""));
  return Number.isFinite(x) ? x : undefined;
}
function bool(n: unknown): boolean {
  const s = typeof n === "object" ? val(n) : n === undefined ? undefined : String(n);
  return s === "1" || s?.toLowerCase() === "true";
}
function footIds(n: unknown): string[] {
  const ids: string[] = [];
  const walk = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k === "footnoteId") {
        for (const f of v as Record<string, string>[]) if (f?.["@id"]) ids.push(f["@id"]);
      } else if (typeof v === "object") walk(v);
    }
  };
  walk(n);
  return [...new Set(ids)];
}

export interface InsiderTransaction {
  security: string | undefined;
  derivative: boolean;
  date: string | undefined;
  code: string | undefined;
  code_meaning: string | undefined;
  shares: number | undefined;
  price: number | undefined;
  value: number | undefined;
  acquired_disposed: "A" | "D" | undefined;
  shares_owned_after: number | undefined;
  ownership: "D" | "I" | undefined;
  indirect_nature?: string;
  underlying_security?: string;
  underlying_shares?: number;
  exercise_price?: number;
  footnotes?: string[];
}

export interface ParsedForm4 {
  document_type?: string;
  period?: string;
  issuer: { cik?: string; name?: string; ticker?: string };
  reporters: { name?: string; cik?: string; roles: string[]; officer_title?: string }[];
  rule_10b5_1?: boolean;
  transactions: InsiderTransaction[];
  footnotes: Record<string, string>;
  remarks?: string;
}

export function parseForm4(xml: string): ParsedForm4 {
  const doc = (parser.parse(xml) as Record<string, Node>).ownershipDocument as Record<string, unknown> | undefined;
  if (!doc) throw new Error("Not an ownershipDocument");
  const issuer = (doc.issuer ?? {}) as Record<string, unknown>;
  const reporters = ((doc.reportingOwner ?? []) as Record<string, Record<string, unknown>>[]).map((ro) => {
    const id = ro.reportingOwnerId ?? {};
    const rel = ro.reportingOwnerRelationship ?? {};
    const roles: string[] = [];
    if (bool(rel.isDirector)) roles.push("Director");
    if (bool(rel.isOfficer)) roles.push("Officer");
    if (bool(rel.isTenPercentOwner)) roles.push("10% Owner");
    if (bool(rel.isOther)) roles.push(rel.otherText ? `Other: ${String(rel.otherText)}` : "Other");
    return {
      name: id.rptOwnerName ? String(id.rptOwnerName) : undefined,
      cik: id.rptOwnerCik ? String(id.rptOwnerCik) : undefined,
      roles,
      officer_title: rel.officerTitle ? String(rel.officerTitle) : undefined,
    };
  });
  const footnotes: Record<string, string> = {};
  const fns = ((doc.footnotes as Record<string, unknown>)?.footnote ?? []) as (Record<string, string> | string)[];
  for (const f of fns) if (typeof f === "object" && f["@id"]) footnotes[f["@id"]] = String(f["#text"] ?? "").replace(/\s+/g, " ").trim();

  const txs: InsiderTransaction[] = [];
  const mk = (t: Record<string, Record<string, unknown>>, derivative: boolean): InsiderTransaction => {
    const amt = t.transactionAmounts ?? {};
    const code = t.transactionCoding?.transactionCode ? String(t.transactionCoding.transactionCode) : undefined;
    const shares = numVal(amt.transactionShares);
    const price = numVal(amt.transactionPricePerShare);
    const ad = val(amt.transactionAcquiredDisposedCode) as "A" | "D" | undefined;
    const own = t.ownershipNature ?? {};
    const und = t.underlyingSecurity ?? {};
    return {
      security: val(t.securityTitle),
      derivative,
      date: val(t.transactionDate)?.slice(0, 10),
      code,
      code_meaning: code ? TRANSACTION_CODES[code] : undefined,
      shares,
      price,
      value: shares !== undefined && price !== undefined && price > 0 ? Math.round(shares * price * 100) / 100 : undefined,
      acquired_disposed: ad,
      shares_owned_after: numVal(t.postTransactionAmounts?.sharesOwnedFollowingTransaction),
      ownership: val(own.directOrIndirectOwnership) as "D" | "I" | undefined,
      indirect_nature: val(own.natureOfOwnership),
      underlying_security: derivative ? val(und.underlyingSecurityTitle) : undefined,
      underlying_shares: derivative ? numVal(und.underlyingSecurityShares) : undefined,
      exercise_price: derivative ? numVal(t.conversionOrExercisePrice) : undefined,
      footnotes: footIds(t),
    };
  };
  const nd = (doc.nonDerivativeTable ?? {}) as Record<string, unknown>;
  for (const t of (nd.nonDerivativeTransaction ?? []) as Record<string, Record<string, unknown>>[]) txs.push(mk(t, false));
  const dt = (doc.derivativeTable ?? {}) as Record<string, unknown>;
  for (const t of (dt.derivativeTransaction ?? []) as Record<string, Record<string, unknown>>[]) txs.push(mk(t, true));

  return {
    document_type: doc.documentType ? String(doc.documentType) : undefined,
    period: doc.periodOfReport ? String(doc.periodOfReport) : undefined,
    issuer: {
      cik: issuer.issuerCik ? String(issuer.issuerCik) : undefined,
      name: issuer.issuerName ? String(issuer.issuerName) : undefined,
      ticker: issuer.issuerTradingSymbol ? String(issuer.issuerTradingSymbol) : undefined,
    },
    reporters,
    rule_10b5_1: doc.aff10b5One !== undefined ? bool(doc.aff10b5One) : undefined,
    transactions: txs,
    footnotes,
    remarks: doc.remarks ? String(doc.remarks).slice(0, 500) : undefined,
  };
}

/** Raw XML URL for a Form 4: primaryDocument is often the XSL-rendered path "xslF345X05/form4.xml". */
export function form4XmlUrl(f: FilingRow, cik: string): string | undefined {
  if (!f.primary_doc) return undefined;
  const doc = f.primary_doc.replace(/^xsl[^/]+\//i, "");
  return `${archiveBase(cik, f.accession)}/${doc}`;
}

export interface InsiderOptions {
  cik: string;
  limit: number;
  includeAmendments: boolean;
  dateFrom?: string;
  dateTo?: string;
  codes?: string[];
  includeFootnotes: boolean;
}

export async function getInsiderTrades(o: InsiderOptions) {
  const forms = o.includeAmendments ? ["4", "4/A"] : ["4"];
  const list = await listFilings(o.cik, { forms, includeAmendments: o.includeAmendments, dateFrom: o.dateFrom, dateTo: o.dateTo }, o.limit);
  const results = await Promise.all(
    list.filings.map(async (f) => {
      const url = form4XmlUrl(f, o.cik);
      if (!url || !/\.xml$/i.test(url)) return { f, error: "no XML document" as const };
      try {
        // Raw XML stays in process memory; the small parsed result is shared.
        const parsed = await derived(`form4:${url}`, TTL.filingDocShared, async () =>
          parseForm4(await getText(url, "sec", TTL.filingDoc, { tier: "memory", maxBytes: 2 * 1024 * 1024 })),
        );
        return { f, url, parsed };
      } catch (e) {
        const te = toToolError(e);
        if (te.code === "RATE_LIMITED" || te.code === "CONFIG_ERROR") throw te;
        return { f, error: te.message };
      }
    }),
  );
  const filings: Record<string, unknown>[] = [];
  const summary = {
    open_market_buys: { count: 0, shares: 0, value: 0 },
    open_market_sales: { count: 0, shares: 0, value: 0 },
  };
  let skippedNotIssuer = 0;
  const errors: { accession: string; error: string }[] = [];
  const codesSeen = new Set<string>();
  const codeSet = o.codes?.length ? new Set(o.codes.map((c) => c.toUpperCase())) : undefined;
  for (const r of results) {
    if ("error" in r && r.error) {
      errors.push({ accession: r.f.accession, error: r.error });
      continue;
    }
    const p = r.parsed!;
    if (p.issuer.cik && Number(p.issuer.cik) !== Number(o.cik)) {
      skippedNotIssuer++; // company is the *reporting owner* in this filing, not the issuer
      continue;
    }
    let txs = p.transactions;
    if (codeSet) txs = txs.filter((t) => t.code && codeSet.has(t.code));
    for (const t of txs) {
      if (t.derivative) continue;
      if (t.code === "P") {
        summary.open_market_buys.count++;
        summary.open_market_buys.shares += t.shares ?? 0;
        summary.open_market_buys.value += t.value ?? 0;
      } else if (t.code === "S") {
        summary.open_market_sales.count++;
        summary.open_market_sales.shares += t.shares ?? 0;
        summary.open_market_sales.value += t.value ?? 0;
      }
    }
    if (codeSet && !txs.length) continue;
    const usedNotes = new Set(txs.flatMap((t) => t.footnotes ?? []));
    filings.push(
      compact({
        form: r.f.form,
        filed: r.f.filed,
        accession: r.f.accession,
        reporter: p.reporters.map((x) => x.name).join("; "),
        roles: [...new Set(p.reporters.flatMap((x) => x.roles))].join(", "),
        officer_title: p.reporters.map((x) => x.officer_title).filter(Boolean).join("; "),
        rule_10b5_1: p.rule_10b5_1 || undefined,
        transactions: txs.map((t) => {
          const { footnotes, derivative, code_meaning: _m, ...rest } = t;
          if (t.code) codesSeen.add(t.code);
          return { ...rest, derivative: derivative || undefined, footnotes: o.includeFootnotes && footnotes?.length ? footnotes : undefined };
        }),
        footnotes: o.includeFootnotes && usedNotes.size ? Object.fromEntries([...usedNotes].map((id) => [id, p.footnotes[id] ? stripInvisible(p.footnotes[id]!).slice(0, 400) : undefined])) : undefined,
        url: r.url,
      }),
    );
  }
  summary.open_market_buys.value = Math.round(summary.open_market_buys.value);
  summary.open_market_sales.value = Math.round(summary.open_market_sales.value);
  return compact({
    cik: list.cik,
    name: list.name,
    filings_returned: filings.length,
    summary,
    code_legend: Object.fromEntries([...codesSeen].sort().map((c) => [c, TRANSACTION_CODES[c] ?? "Unknown"])),
    filings,
    skipped_as_reporting_owner: skippedNotIssuer || undefined,
    errors: errors.length ? errors : undefined,
    has_more: list.has_more,
    note: "Only P/S are open-market trades. value = shares x price. ownership D=direct, I=indirect.",
  });
}
