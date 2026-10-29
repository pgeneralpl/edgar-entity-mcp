import { getJson } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { daysBetween, padCik } from "../core/util.js";
import { dice } from "./tickers.js";
import type { ConceptFacts, Fact } from "./xbrlTypes.js";
import { getCompanyFacts, METRICS } from "./financials.js";
import { FRAME_METRICS, canonicalMetric, frameTagsFor, knownTagCase } from "./metricAliases.js";

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
  /** Keep only facts of this period length (annual ≈ 1 year, quarterly ≈ 3 months, ytd = 6/9 months, instant = point in time). */
  duration?: Duration;
  limit: number;
}

export const DURATIONS = ["any", "annual", "quarterly", "ytd", "instant"] as const;
export type Duration = (typeof DURATIONS)[number];

/** Classify a fact by period length. */
export function durationOf(f: { start?: string; end: string }): Exclude<Duration, "any"> | "other" {
  if (!f.start) return "instant";
  const d = daysBetween(f.start, f.end);
  if (d >= 340 && d <= 390) return "annual";
  if (d >= 80 && d <= 100) return "quarterly";
  if (d > 100 && d < 340) return "ytd";
  return "other";
}

export function selectConceptFacts(units: Record<string, Fact[]>, q: Pick<ConceptQuery, "unit" | "forms" | "framedOnly" | "limit" | "duration">) {
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
  const kinds = new Set(facts.map((f) => durationOf(f)));
  if (q.duration && q.duration !== "any") facts = facts.filter((f) => durationOf(f) === q.duration);
  // dedupe identical (start,end) keeping latest filed
  const byPeriod = new Map<string, Fact>();
  for (const f of facts) {
    const k = `${f.start ?? ""}|${f.end}`;
    const cur = byPeriod.get(k);
    if (!cur || cur.filed < f.filed) byPeriod.set(k, f);
  }
  const rows = [...byPeriod.values()].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : (a.start ?? "") < (b.start ?? "") ? 1 : -1));
  const mixed = (!q.duration || q.duration === "any") && [...kinds].filter((k) => k !== "instant").length > 1;
  return {
    unit,
    available_units: available,
    duration: q.duration ?? "any",
    total: rows.length,
    note: mixed
      ? `Facts mix period lengths (${[...kinds].sort().join(", ")}): 10-Qs report 3-month and year-to-date values, 10-Ks annual ones. Pass duration ('annual', 'quarterly', 'ytd' or 'instant') for one series.`
      : undefined,
    facts: rows.slice(0, q.limit).map((f) => ({
      start: f.start,
      end: f.end,
      duration: durationOf(f),
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

/** Exact-case tag for a known metric tag (get_financials / compare_companies lists), without a request. */
function knownTag(taxonomy: string, tag: string): string | undefined {
  const want = `${taxonomy}:${tag}`.toLowerCase();
  for (const m of METRICS) for (const t of m.tags) if (t.toLowerCase() === want) return t.split(":")[1];
  return knownTagCase(taxonomy, tag);
}

export async function getConcept(q: ConceptQuery) {
  const fixed = knownTag(q.taxonomy, q.tag);
  const tag = fixed ?? q.tag;
  const corrected = fixed && fixed !== q.tag ? q.tag : undefined;
  const url = conceptUrl(q.cik, q.taxonomy, tag);
  let r: ConceptResponse;
  try {
    r = await getJson<ConceptResponse>(url, "sec", TTL.companyConcept);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return conceptFromCompanyFacts(q);
    throw e;
  }
  const sel = selectConceptFacts(r.units, q);
  return {
    cik: padCik(r.cik),
    name: r.entityName,
    concept: `${r.taxonomy}:${r.tag}`,
    tag_corrected_from: corrected,
    label: r.label ?? undefined,
    description: r.description ? r.description.slice(0, 300) : undefined,
    ...sel,
    source_url: url,
  };
}

/** Max tags suggested when a concept is not found. */
const MAX_TAG_SUGGESTIONS = 5;

/**
 * The companyconcept API is case-sensitive and 404s on unknown tags. Fall back to the company's
 * companyfacts (one cached document, shared with get_financials) to match the tag case-insensitively
 * or suggest similar tags the company does report.
 */
async function conceptFromCompanyFacts(q: ConceptQuery) {
  const cf = await getCompanyFacts(q.cik);
  const want = q.tag.toLowerCase();
  const taxonomies = Object.keys(cf.facts ?? {});
  const ordered = [q.taxonomy, ...taxonomies.filter((t) => t !== q.taxonomy)];
  for (const tax of ordered) {
    const concepts = cf.facts?.[tax];
    if (!concepts) continue;
    const hit = Object.keys(concepts).find((k) => k.toLowerCase() === want);
    if (!hit) continue;
    const c = concepts[hit]!;
    return {
      cik: padCik(cf.cik),
      name: cf.entityName,
      concept: `${tax}:${hit}`,
      tag_corrected_from: hit !== q.tag || tax !== q.taxonomy ? `${q.taxonomy}:${q.tag}` : undefined,
      label: c.label ?? undefined,
      description: c.description ? c.description.slice(0, 300) : undefined,
      ...selectConceptFacts(c.units, q),
      source_url: conceptUrl(padCik(cf.cik), tax, hit),
    };
  }
  const scored: { ref: string; s: number }[] = [];
  for (const tax of ordered)
    for (const k of Object.keys(cf.facts?.[tax] ?? {})) {
      const s = dice(want, k.toLowerCase());
      if (s >= 0.45) scored.push({ ref: `${tax}:${k}`, s });
    }
  scored.sort((a, b) => b.s - a.s);
  throw new ToolError(
    "NOT_FOUND",
    `${q.taxonomy}:${q.tag} not reported by CIK ${padCik(q.cik)}.`,
    "Check the tag name (e.g. 'Revenues', 'NetIncomeLoss', 'RevenueFromContractWithCustomerExcludingAssessedTax'), or use get_financials for normalized metrics.",
    { did_you_mean: scored.slice(0, MAX_TAG_SUGGESTIONS).map((x) => x.ref) },
  );
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

/** Last day of a calendar frame period (CY2024 → 2024-12-31, CY2024Q2 / CY2024Q2I → 2024-06-30). */
export function calendarPeriodEnd(period: string): string | undefined {
  const m = /^CY(\d{4})(?:Q([1-4]))?I?$/.exec(period);
  if (!m) return undefined;
  const q = m[2] ? Number(m[2]) : 4;
  return `${m[1]}-${["03-31", "06-30", "09-30", "12-31"][q - 1]}`;
}

/** Days a filer's period may end away from the calendar period end and still count as calendar-aligned (52/53-week years). */
const CALENDAR_SLACK_DAYS = 14;

type FrameRow = FrameResponse["data"][number];

async function fetchFrame(taxonomy: string, tag: string, unit: string, period: string, missingOk: boolean): Promise<FrameResponse | undefined> {
  const url = frameUrl(taxonomy, tag, unit, period);
  try {
    return await getJson<FrameResponse>(url, "sec", TTL.frames);
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      if (missingOk) return undefined;
      throw new ToolError(
        "NOT_FOUND",
        `No frame for ${taxonomy}:${tag} ${unit} ${period}.`,
        "Balance-sheet (instant) concepts need an 'I' suffix, e.g. CY2023Q4I. Check the tag spelling and unit (USD, USD-per-shares, shares), or pass metric (e.g. 'revenue') to try the common tags.",
      );
    }
    throw e;
  }
}

interface RankedRow extends FrameRow {
  tag?: string;
}

function shapeResults(rows: RankedRow[], period: string, opts: { ciks?: string[]; limit: number; order: "desc" | "asc" }) {
  const ranked = [...rows].sort((a, b) => (opts.order === "asc" ? a.val - b.val : b.val - a.val));
  const rank = new Map(ranked.map((d, i) => [d.cik, i + 1]));
  let data = ranked;
  let missing: string[] | undefined;
  if (opts.ciks?.length) {
    const want = new Set(opts.ciks.map((c) => Number(c)));
    data = ranked.filter((d) => want.has(d.cik));
    const found = new Set(data.map((d) => d.cik));
    missing = opts.ciks.filter((c) => !found.has(Number(c))).map((c) => padCik(c));
  }
  const calEnd = calendarPeriodEnd(period);
  const results = data.slice(0, opts.limit).map((d) => {
    const off = calEnd ? Math.abs(daysBetween(d.end, calEnd)) > CALENDAR_SLACK_DAYS : false;
    return {
      rank: rank.get(d.cik),
      cik: padCik(d.cik),
      name: d.entityName,
      val: d.val,
      start: d.start,
      end: d.end,
      fiscal_period_differs: off || undefined,
      tag: d.tag,
      accn: d.accn,
      loc: d.loc,
    };
  });
  const notes = [
    "Calendar-period comparison: SEC frames take each filer's period that best fits the calendar period (≈365 days for CY2024, ≈91 days for a quarter). accn is the latest filing that reported the value (often the next year's 10-K, as a comparative).",
  ];
  const offCal = results.filter((r) => r.fiscal_period_differs);
  if (offCal.length)
    notes.push(
      `${offCal.length} result(s) are fiscal periods ending away from ${calEnd} (fiscal_period_differs, e.g. ${offCal[0]!.name}: ${offCal[0]!.start ?? "?"}..${offCal[0]!.end}). For fiscal-year figures use get_financials.`,
    );
  return { results, missing_ciks: missing?.length ? missing : undefined, total_ranked: ranked.length, notes };
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
  const r = (await fetchFrame(opts.taxonomy, opts.tag, opts.unit, period, false))!;
  const shaped = shapeResults(r.data, period, opts);
  const notes = shaped.notes;
  // A tag that belongs to a metric with alternatives: say so instead of silently dropping companies.
  const metric = Object.entries(FRAME_METRICS).find(([, m]) => m.tags.some((t) => t.ref === `${opts.taxonomy}:${opts.tag}`))?.[0];
  if (shaped.missing_ciks && metric && FRAME_METRICS[metric]!.tags.length > 1)
    notes.push(`Some companies report ${metric} under another tag (${FRAME_METRICS[metric]!.tags.map((t) => t.ref.split(":")[1]).join(", ")}). Pass metric: '${metric}' instead of tag to fall back across them.`);
  return {
    concept: `${r.taxonomy}:${r.tag}`,
    label: r.label,
    unit: r.uom,
    period: r.ccp,
    period_basis: "calendar" as const,
    companies_reporting: r.pts,
    results: shaped.results,
    missing_ciks: shaped.missing_ciks,
    notes,
    source_url: frameUrl(opts.taxonomy, opts.tag, opts.unit, period),
  };
}

/**
 * compare_companies by metric: fetch the frames of the metric's tags (≤ MAX_FRAME_TAGS) and keep,
 * per company, the value of the first tag it reports. With a company filter the tags are fetched
 * one at a time and the loop stops once every company has a value (fewer SEC requests).
 */
export async function getMetricFrame(opts: { metric: string; period: string; unit?: string; ciks?: string[]; limit: number; order: "desc" | "asc" }) {
  const key = canonicalMetric(opts.metric);
  const m = FRAME_METRICS[key];
  if (!m) throw new ToolError("INVALID_INPUT", `Unknown metric "${opts.metric}".`, `Use one of: ${Object.keys(FRAME_METRICS).join(", ")}.`);
  let period = normalizePeriod(opts.period);
  const notes: string[] = [];
  const instant = period.endsWith("I");
  if (m.kind === "instant" && !instant) {
    const adjusted = /Q[1-4]$/.test(period) ? `${period}I` : `${period}Q4I`;
    notes.push(`${key} is a balance-sheet (point-in-time) item, so period ${period} was read as ${adjusted} (value at the end of the period).`);
    period = adjusted;
  } else if (m.kind === "duration" && instant)
    throw new ToolError("INVALID_INPUT", `${key} is a flow (duration) metric; "${period}" is an instant period.`, "Use CY2024 (year) or CY2024Q2 (quarter) without the I suffix.");
  const year = Number(period.slice(2, 6));
  const tags = frameTagsFor(key, year);
  const unit = opts.unit ?? m.unit;
  const byCik = new Map<number, RankedRow>();
  const tried: string[] = [];
  const counts: Record<string, number> = {};
  let label: string | undefined;
  const add = (ref: string, r: FrameResponse | undefined) => {
    tried.push(ref);
    if (!r) return;
    label ??= r.label;
    for (const d of r.data)
      if (!byCik.has(d.cik)) {
        byCik.set(d.cik, { ...d, tag: ref });
        counts[ref] = (counts[ref] ?? 0) + 1;
      }
  };
  const split = (ref: string) => ref.split(":") as [string, string];
  if (opts.ciks?.length) {
    const want = opts.ciks.map((c) => Number(c));
    for (const ref of tags) {
      add(ref, await fetchFrame(...split(ref), unit, period, true));
      if (want.every((c) => byCik.has(c))) break;
    }
  } else {
    const frames = await Promise.all(tags.map((ref) => fetchFrame(...split(ref), unit, period, true)));
    tags.forEach((ref, i) => add(ref, frames[i]));
  }
  if (!byCik.size)
    throw new ToolError("NOT_FOUND", `No ${key} frame data for ${period} (${unit}).`, "The period may not be reported yet (frames lag filings by weeks) or the unit differs; try an earlier period.", {
      tags_tried: tried,
    });
  const shaped = shapeResults([...byCik.values()], period, opts);
  const tagsUsed = [...new Set(shaped.results.map((r) => r.tag).filter((t): t is string => !!t))];
  return {
    metric: key,
    metric_alias: key !== opts.metric ? opts.metric : undefined,
    label,
    unit,
    period,
    period_basis: "calendar" as const,
    companies_reporting: byCik.size,
    results: shaped.results,
    missing_ciks: shaped.missing_ciks,
    tags_tried: tried,
    tags_used: tagsUsed,
    companies_per_tag: counts,
    notes: [
      `Each company's value comes from the first of ${tried.map((t) => t.split(":")[1]).join(" > ")} that it reports for the period (see tag per result).`,
      ...notes,
      ...shaped.notes,
    ],
    source_urls: tried.map((ref) => frameUrl(...split(ref), unit, period)),
  };
}
