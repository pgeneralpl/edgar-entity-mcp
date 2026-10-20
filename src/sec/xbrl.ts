import { getJson } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { padCik } from "../core/util.js";
import type { ConceptFacts, Fact } from "./xbrlTypes.js";

export const conceptUrl = (cik: string, taxonomy: string, tag: string) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${padCik(cik)}/${encodeURIComponent(taxonomy)}/${encodeURIComponent(tag)}.json`;

export const frameUrl = (taxonomy: string, tag: string, unit: string, period: string) =>
  `https://data.sec.gov/api/xbrl/frames/${encodeURIComponent(taxonomy)}/${encodeURIComponent(tag)}/${encodeURIComponent(unit)}/${encodeURIComponent(period)}.json`;

interface ConceptResponse extends ConceptFacts {
  cik: number;
  taxonomy: string;
  tag: string;
  entityName: string;
}

export interface ConceptQuery {
  cik: string;
  taxonomy: string;
  tag: string;
  unit?: string;
  forms?: string[];
  framedOnly: boolean;
  limit: number;
}

export function selectConceptFacts(units: Record<string, Fact[]>, q: Pick<ConceptQuery, "unit" | "forms" | "framedOnly" | "limit">) {
  const available = Object.keys(units);
  const unit = q.unit ?? available.find((u) => u === "USD") ?? available[0];
  if (!unit || !units[unit])
    throw new ToolError("NOT_FOUND", `Unit "${q.unit}" not reported for this concept.`, `Available units: ${available.join(", ")}`);
  let facts = units[unit]!;
  if (q.forms?.length) {
    const want = q.forms.map((f) => f.toUpperCase());
    facts = facts.filter((f) => want.includes(f.form.toUpperCase()));
  }
  if (q.framedOnly) facts = facts.filter((f) => f.frame);
  // dedupe identical (start,end) keeping latest filed
  const byPeriod = new Map<string, Fact>();
  for (const f of facts) {
    const k = `${f.start ?? ""}|${f.end}`;
    const cur = byPeriod.get(k);
    if (!cur || cur.filed < f.filed) byPeriod.set(k, f);
  }
  const rows = [...byPeriod.values()].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : (a.start ?? "") < (b.start ?? "") ? 1 : -1));
  return {
    unit,
    available_units: available,
    total: rows.length,
    facts: rows.slice(0, q.limit).map((f) => ({
      start: f.start,
      end: f.end,
      val: f.val,
      fy: f.fy ?? undefined,
      fp: f.fp ?? undefined,
      form: f.form,
      filed: f.filed,
      accn: f.accn,
      frame: f.frame,
    })),
  };
}

export async function getConcept(q: ConceptQuery) {
  const url = conceptUrl(q.cik, q.taxonomy, q.tag);
  let r: ConceptResponse;
  try {
    r = await getJson<ConceptResponse>(url, "sec", TTL.companyConcept);
  } catch (e) {
    if ((e as { status?: number }).status === 404)
      throw new ToolError(
        "NOT_FOUND",
        `${q.taxonomy}:${q.tag} not reported by CIK ${padCik(q.cik)}.`,
        "Tags are case-sensitive (e.g. 'Revenues', 'NetIncomeLoss', 'RevenueFromContractWithCustomerExcludingAssessedTax'). Try get_financials for normalized metrics.",
      );
    throw e;
  }
  const sel = selectConceptFacts(r.units, q);
  return {
    cik: padCik(r.cik),
    name: r.entityName,
    concept: `${r.taxonomy}:${r.tag}`,
    label: r.label ?? undefined,
    description: r.description ? r.description.slice(0, 300) : undefined,
    ...sel,
    source_url: url,
  };
}

interface FrameResponse {
  taxonomy: string;
  tag: string;
  ccp: string;
  uom: string;
  label?: string;
  description?: string;
  pts: number;
  data: { accn: string; cik: number; entityName: string; loc?: string; start?: string; end: string; val: number }[];
}

export function normalizePeriod(p: string): string {
  const s = p.toUpperCase().replace(/\s+/g, "");
  if (/^CY\d{4}(Q[1-4])?I?$/.test(s)) return s;
  if (/^\d{4}$/.test(s)) return `CY${s}`;
  const m = /^(\d{4})Q([1-4])(I?)$/.exec(s) ?? /^Q([1-4])(\d{4})(I?)$/.exec(s);
  if (m) return /^\d{4}/.test(s) ? `CY${m[1]}Q${m[2]}${m[3]}` : `CY${m[2]}Q${m[1]}${m[3]}`;
  throw new ToolError("INVALID_INPUT", `Invalid period "${p}". Use CY2023 (annual), CY2023Q4 (quarter), or CY2023Q4I (instant, for balance-sheet items).`);
}

export async function getFrame(opts: {
  taxonomy: string;
  tag: string;
  unit: string;
  period: string;
  ciks?: string[];
  limit: number;
  order: "desc" | "asc";
}) {
  const period = normalizePeriod(opts.period);
  const url = frameUrl(opts.taxonomy, opts.tag, opts.unit, period);
  let r: FrameResponse;
  try {
    r = await getJson<FrameResponse>(url, "sec", TTL.frames);
  } catch (e) {
    if ((e as { status?: number }).status === 404)
      throw new ToolError(
        "NOT_FOUND",
        `No frame for ${opts.taxonomy}:${opts.tag} ${opts.unit} ${period}.`,
        "Balance-sheet (instant) concepts need an 'I' suffix, e.g. CY2023Q4I. Check the tag spelling and unit (USD, USD-per-shares, shares).",
      );
    throw e;
  }
  let data = r.data;
  const ranked = [...data].sort((a, b) => (opts.order === "asc" ? a.val - b.val : b.val - a.val));
  const rank = new Map(ranked.map((d, i) => [d.cik, i + 1]));
  let missing: string[] | undefined;
  if (opts.ciks?.length) {
    const want = new Set(opts.ciks.map((c) => Number(c)));
    data = ranked.filter((d) => want.has(d.cik));
    const found = new Set(data.map((d) => d.cik));
    missing = opts.ciks.filter((c) => !found.has(Number(c))).map((c) => padCik(c));
  } else data = ranked;
  return {
    concept: `${r.taxonomy}:${r.tag}`,
    label: r.label,
    unit: r.uom,
    period: r.ccp,
    companies_reporting: r.pts,
    results: data.slice(0, opts.limit).map((d) => ({
      rank: rank.get(d.cik),
      cik: padCik(d.cik),
      name: d.entityName,
      val: d.val,
      start: d.start,
      end: d.end,
      accn: d.accn,
      loc: d.loc,
    })),
    missing_ciks: missing?.length ? missing : undefined,
    source_url: url,
  };
}
