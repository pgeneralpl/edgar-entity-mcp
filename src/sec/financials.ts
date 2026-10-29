import { getJson, derived } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { daysBetween, padCik } from "../core/util.js";
import type { CompanyFacts, Fact } from "./xbrlTypes.js";

export const companyFactsUrl = (cik: string | number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(cik)}.json`;

export async function getCompanyFacts(cik: string | number): Promise<CompanyFacts> {
  try {
    return await getJson<CompanyFacts>(companyFactsUrl(cik), "sec", TTL.companyFacts);
  } catch (e) {
    if ((e as { status?: number }).status === 404)
      throw new ToolError("NOT_FOUND", `No XBRL financial data for CIK ${padCik(cik)}.`, "The company may not file XBRL (e.g. funds, some foreign private issuers, or very old filers).");
    throw e;
  }
}

type UnitKind = "currency" | "pershare" | "shares";
type Kind = "duration" | "instant" | "cover";

interface MetricDef {
  key: string;
  kind: Kind;
  unit: UnitKind;
  tags: string[]; // "taxonomy:Tag"
  /** whether values can be derived by subtraction for quarterly (flows yes, EPS no) */
  additive: boolean;
}

export const METRICS: MetricDef[] = [
  {
    key: "revenue",
    kind: "duration",
    unit: "currency",
    additive: true,
    tags: [
      "us-gaap:Revenues",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
      "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
      "us-gaap:SalesRevenueNet",
      "us-gaap:SalesRevenueGoodsNet",
      "us-gaap:SalesRevenueServicesNet",
      "us-gaap:RevenuesNetOfInterestExpense",
      "us-gaap:InterestAndDividendIncomeOperating",
      "ifrs-full:Revenue",
    ],
  },
  { key: "gross_profit", kind: "duration", unit: "currency", additive: true, tags: ["us-gaap:GrossProfit", "ifrs-full:GrossProfit"] },
  {
    key: "operating_income",
    kind: "duration",
    unit: "currency",
    additive: true,
    tags: ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"],
  },
  {
    key: "net_income",
    kind: "duration",
    unit: "currency",
    additive: true,
    tags: [
      "us-gaap:NetIncomeLoss",
      "us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic",
      "us-gaap:ProfitLoss",
      "ifrs-full:ProfitLossAttributableToOwnersOfParent",
      "ifrs-full:ProfitLoss",
    ],
  },
  {
    key: "eps_basic",
    kind: "duration",
    unit: "pershare",
    additive: false,
    tags: ["us-gaap:EarningsPerShareBasic", "us-gaap:EarningsPerShareBasicAndDiluted", "ifrs-full:BasicEarningsLossPerShare"],
  },
  {
    key: "eps_diluted",
    kind: "duration",
    unit: "pershare",
    additive: false,
    tags: ["us-gaap:EarningsPerShareDiluted", "us-gaap:EarningsPerShareBasicAndDiluted", "ifrs-full:DilutedEarningsLossPerShare"],
  },
  {
    key: "operating_cash_flow",
    kind: "duration",
    unit: "currency",
    additive: true,
    tags: [
      "us-gaap:NetCashProvidedByUsedInOperatingActivities",
      "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
      "ifrs-full:CashFlowsFromUsedInOperatingActivities",
    ],
  },
  {
    key: "capex",
    kind: "duration",
    unit: "currency",
    additive: true,
    tags: [
      "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
      "us-gaap:PaymentsToAcquireProductiveAssets",
      "us-gaap:PaymentsForCapitalImprovements",
      "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
    ],
  },
  { key: "total_assets", kind: "instant", unit: "currency", additive: false, tags: ["us-gaap:Assets", "ifrs-full:Assets"] },
  { key: "total_liabilities", kind: "instant", unit: "currency", additive: false, tags: ["us-gaap:Liabilities", "ifrs-full:Liabilities"] },
  {
    key: "stockholders_equity",
    kind: "instant",
    unit: "currency",
    additive: false,
    tags: [
      "us-gaap:StockholdersEquity",
      "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
      "ifrs-full:EquityAttributableToOwnersOfParent",
      "ifrs-full:Equity",
    ],
  },
  {
    key: "cash",
    kind: "instant",
    unit: "currency",
    additive: false,
    tags: [
      "us-gaap:CashAndCashEquivalentsAtCarryingValue",
      "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
      "us-gaap:Cash",
      "ifrs-full:CashAndCashEquivalents",
    ],
  },
  {
    key: "long_term_debt",
    kind: "instant",
    unit: "currency",
    additive: false,
    tags: ["us-gaap:LongTermDebtNoncurrent", "us-gaap:LongTermDebt", "ifrs-full:NoncurrentPortionOfNoncurrentBorrowings"],
  },
  {
    key: "shares_outstanding",
    kind: "cover",
    unit: "shares",
    additive: false,
    tags: ["dei:EntityCommonStockSharesOutstanding", "us-gaap:CommonStockSharesOutstanding"],
  },
];

export const METRIC_KEYS = METRICS.map((m) => m.key);

const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "10-KT/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
const QUARTERLY_FORMS = new Set(["10-Q", "10-Q/A", "10-QT"]);

const dur = (f: Fact) => (f.start ? daysBetween(f.start, f.end) : 0);
const isAnnualDur = (d: number) => d >= 340 && d <= 390;
const isQuarterDur = (d: number) => d >= 80 && d <= 100;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const near = (a: string | undefined, b: string | undefined, days: number) => !!a && !!b && Math.abs(daysBetween(a, b)) <= days;

function pickUnit(units: Record<string, Fact[]>, kind: UnitKind): string | undefined {
  const names = Object.keys(units);
  if (kind === "shares") return names.find((n) => n === "shares");
  if (kind === "pershare") return names.find((n) => n === "USD/shares") ?? names.find((n) => /\/shares$/.test(n));
  return names.find((n) => n === "USD") ?? names.find((n) => /^[A-Z]{3}$/.test(n));
}

export interface Series {
  tag: string;
  unit: string;
  facts: Fact[];
}

export function getSeries(cf: CompanyFacts, ref: string, unitKind: UnitKind): Series | undefined {
  const [tax, tag] = ref.split(":") as [string, string];
  const c = cf.facts?.[tax]?.[tag];
  if (!c) return undefined;
  const unit = pickUnit(c.units, unitKind);
  if (!unit) return undefined;
  return { tag: ref, unit, facts: c.units[unit] ?? [] };
}

export interface Period {
  fy?: number;
  fp: string;
  end: string;
  start?: string;
  form: string;
  accn: string;
  filed: string;
  derived?: boolean;
}

/** Prefer the fact from `accn`, else the most recently filed. */
function choose(facts: Fact[], accn?: string): Fact | undefined {
  if (!facts.length) return undefined;
  if (accn) {
    const own = facts.filter((f) => f.accn === accn);
    if (own.length) return own.sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
  }
  return [...facts].sort((a, b) => (a.filed < b.filed ? 1 : -1))[0];
}

/** Build canonical reporting periods from anchor flow concepts. */
export function buildPeriods(cf: CompanyFacts, mode: "annual" | "quarterly"): Period[] {
  const anchorRefs = [
    ...METRICS.find((m) => m.key === "revenue")!.tags,
    ...METRICS.find((m) => m.key === "net_income")!.tags,
    ...METRICS.find((m) => m.key === "operating_cash_flow")!.tags,
  ];
  const forms = mode === "annual" ? ANNUAL_FORMS : QUARTERLY_FORMS;
  const okDur = mode === "annual" ? isAnnualDur : isQuarterDur;
  const anchors: Fact[] = [];
  for (const ref of anchorRefs) {
    const s = getSeries(cf, ref, "currency");
    if (!s) continue;
    for (const f of s.facts) if (forms.has(f.form) && f.start && okDur(dur(f))) anchors.push(f);
  }
  // A filing's own period = the latest end date among its facts.
  const maxEnd = new Map<string, string>();
  for (const f of anchors) if (!maxEnd.has(f.accn) || maxEnd.get(f.accn)! < f.end) maxEnd.set(f.accn, f.end);
  const byEnd = new Map<string, Fact[]>();
  for (const f of anchors) {
    // bucket ends within 3 days together (52/53-week calendars, tag inconsistencies)
    const key = [...byEnd.keys()].find((k) => near(k, f.end, 3)) ?? f.end;
    if (!byEnd.has(key)) byEnd.set(key, []);
    byEnd.get(key)!.push(f);
  }
  const periods: Period[] = [];
  const offsets: number[] = [];
  for (const [, fs] of byEnd) {
    const primary = fs.filter((f) => maxEnd.get(f.accn) === f.end);
    const pick = choose(primary.length ? primary : fs)!;
    const isPrimary = primary.length > 0;
    const p: Period = {
      fy: isPrimary && pick.fy ? pick.fy : undefined,
      fp: mode === "annual" ? "FY" : (isPrimary && pick.fp) || "Q?",
      end: pick.end,
      start: pick.start,
      form: pick.form,
      accn: pick.accn,
      filed: pick.filed,
    };
    if (p.fy) offsets.push(p.fy - Number(p.end.slice(0, 4)));
    periods.push(p);
  }
  // Fill missing fiscal years using the company's typical fy-vs-calendar offset.
  const offset = mode1(offsets) ?? 0;
  for (const p of periods) if (!p.fy) p.fy = Number(p.end.slice(0, 4)) + offset;
  periods.sort((a, b) => (a.end < b.end ? 1 : -1));
  return periods;
}

function latestAnnualEnd(annual: Period[]): string {
  const a = annual[0];
  return a ? ` (fiscal year ${a.fy} ended ${a.end})` : "";
}

function mode1(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

interface Found {
  value: number;
  tag: string;
  unit: string;
  derived?: string;
}

function findDuration(cf: CompanyFacts, m: MetricDef, p: Period, mode: "annual" | "quarterly", annual?: Period): Found | undefined {
  for (const ref of m.tags) {
    const s = getSeries(cf, ref, m.unit);
    if (!s) continue;
    const okDur = mode === "annual" ? isAnnualDur : isQuarterDur;
    if (!p.derived) {
      const exact = s.facts.filter((f) => f.start && near(f.end, p.end, 3) && okDur(dur(f)) && (!p.start || near(f.start, p.start, 7)));
      const f = choose(exact, p.accn);
      if (f) return { value: f.val, tag: ref, unit: s.unit };
    }
    if (mode === "quarterly" && m.additive) {
      // Q4 = FY - 9M YTD (derived periods)
      if (p.derived && annual) {
        const fy = choose(s.facts.filter((f) => f.start && near(f.end, annual.end, 3) && isAnnualDur(dur(f))), annual.accn);
        const ytd9 = fy && choose(s.facts.filter((f) => f.start && near(f.start, fy.start, 7) && dur(f) >= 260 && dur(f) <= 290));
        if (fy && ytd9) return { value: fy.val - ytd9.val, tag: ref, unit: s.unit, derived: "FY minus 9M YTD" };
        continue;
      }
      // 10-Q cash-flow items are reported year-to-date; derive the quarter by differencing.
      const ytd = choose(s.facts.filter((f) => f.start && near(f.end, p.end, 3) && dur(f) > 100 && dur(f) < 300), p.accn);
      if (ytd) {
        const prev = choose(
          s.facts.filter((f) => f.start && near(f.start, ytd.start, 7) && f.end < p.end && isQuarterDur(dur(ytd) - dur(f)) && !!f.start),
        );
        if (prev) return { value: ytd.val - prev.val, tag: ref, unit: s.unit, derived: "YTD difference" };
      }
    }
  }
  return undefined;
}

function findInstant(cf: CompanyFacts, m: MetricDef, p: Period): Found | undefined {
  for (const ref of m.tags) {
    const s = getSeries(cf, ref, m.unit);
    if (!s) continue;
    const f = choose(s.facts.filter((x) => !x.start && near(x.end, p.end, 3)), p.accn);
    if (f) return { value: f.val, tag: ref, unit: s.unit };
  }
  return undefined;
}

function findCover(cf: CompanyFacts, m: MetricDef, p: Period): Found | undefined {
  for (const ref of m.tags) {
    const s = getSeries(cf, ref, m.unit);
    if (!s) continue;
    if (ref.startsWith("dei:")) {
      const own = s.facts.filter((f) => f.accn === p.accn);
      if (!own.length) continue;
      const lastEnd = own.reduce((a, f) => (f.end > a ? f.end : a), "");
      // multiple share classes are reported as separate facts with the same date: sum distinct values
      const vals = [...new Set(own.filter((f) => f.end === lastEnd).map((f) => f.val))];
      return { value: vals.reduce((a, b) => a + b, 0), tag: ref, unit: s.unit, derived: vals.length > 1 ? `sum of ${vals.length} share classes` : undefined };
    }
    const f = choose(s.facts.filter((x) => !x.start && near(x.end, p.end, 3)), p.accn);
    if (f) return { value: f.val, tag: ref, unit: s.unit };
  }
  return undefined;
}

export interface FinancialsResult {
  cik: string;
  name: string;
  period_type: "annual" | "quarterly";
  currency?: string;
  /** fy/fp are the company's fiscal periods (not calendar years). */
  period_basis: "fiscal";
  /** MM-DD the latest fiscal year ended on (e.g. "06-30" for Microsoft; 52/53-week years vary by a few days). */
  fiscal_year_end?: string;
  periods: Record<string, unknown>[];
  tags_used: Record<string, string[]>;
  notes: string[];
  hint?: string;
  source_url: string;
}

export function computeFinancials(cf: CompanyFacts, mode: "annual" | "quarterly", limit: number, metrics?: string[]): FinancialsResult {
  let periods = buildPeriods(cf, mode);
  const annualPeriods = mode === "quarterly" ? buildPeriods(cf, "annual") : [];
  const annualByEnd = new Map<string, Period>();
  if (mode === "quarterly") {
    // Add derived Q4 periods (companies do not file a 10-Q for Q4).
    for (const a of annualPeriods) {
      if (periods.some((q) => near(q.end, a.end, 3))) continue;
      // Q4 starts the day after the fiscal Q3 (the 10-Q ending ~3 months before the year end).
      const q3 = periods.find((q) => !q.derived && isQuarterDur(daysBetween(q.end, a.end)));
      const start = q3 ? addDays(q3.end, 1) : undefined;
      const q: Period = { fy: a.fy, fp: "Q4", end: a.end, start, form: a.form, accn: a.accn, filed: a.filed, derived: true };
      periods.push(q);
      annualByEnd.set(q.end, a);
    }
    periods.sort((a, b) => (a.end < b.end ? 1 : -1));
  }
  // Dedupe by fiscal period label, keeping the later-ending period.
  const seen = new Set<string>();
  periods = periods.filter((p) => {
    const k = `${p.fy}-${p.fp}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  periods = periods.slice(0, limit);

  const wanted = METRICS.filter((m) => !metrics?.length || metrics.includes(m.key));
  const tagsUsed: Record<string, string[]> = {};
  const derivations = new Map<string, Set<string>>();
  const addDeriv = (how: string, metric: string) => {
    if (!derivations.has(how)) derivations.set(how, new Set());
    derivations.get(how)!.add(metric);
  };
  let currency: string | undefined;
  const out = periods.map((p) => {
    const row: Record<string, unknown> = {
      fy: p.fy,
      fp: p.fp,
      period_end: p.end,
      period_start: p.start,
      form: p.form,
      filed: p.filed,
      accession: p.accn,
    };
    if (p.derived) row.derived_period = true;
    const vals: Record<string, number | undefined> = {};
    for (const m of wanted) {
      const r = m.kind === "duration" ? findDuration(cf, m, p, mode, annualByEnd.get(p.end)) : m.kind === "instant" ? findInstant(cf, m, p) : findCover(cf, m, p);
      if (!r) continue;
      vals[m.key] = r.value;
      row[m.key] = r.value;
      if (m.unit === "currency" && !currency) currency = r.unit;
      const used = (tagsUsed[m.key] ??= []);
      if (!used.includes(r.tag)) used.push(r.tag);
      if (r.derived) addDeriv(r.derived, m.key);
    }
    // Derived metrics
    const wantKey = (k: string) => !metrics?.length || metrics.includes(k);
    if (wantKey("free_cash_flow") && vals.operating_cash_flow !== undefined && vals.capex !== undefined) {
      row.free_cash_flow = vals.operating_cash_flow - vals.capex;
    }
    if (wantKey("total_liabilities") && vals.total_liabilities === undefined && vals.stockholders_equity !== undefined) {
      const tot = findInstant(cf, { key: "le", kind: "instant", unit: "currency", additive: false, tags: ["us-gaap:LiabilitiesAndStockholdersEquity"] }, p);
      const eqIncl = findInstant(
        cf,
        { key: "eq", kind: "instant", unit: "currency", additive: false, tags: ["us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "us-gaap:StockholdersEquity"] },
        p,
      );
      if (tot && eqIncl) {
        row.total_liabilities = tot.value - eqIncl.value;
        addDeriv("LiabilitiesAndStockholdersEquity minus total equity (no Liabilities tag)", "total_liabilities");
      }
    }
    if (p.start === undefined) delete row.period_start;
    return row;
  });

  const notes: string[] = [];
  if (out.length)
    notes.push(
      `Raw values as reported (not scaled); EPS per share; free_cash_flow = operating_cash_flow - capex. fy/fp are fiscal periods${latestAnnualEnd(mode === "annual" ? periods : annualPeriods)} (compare_companies uses calendar periods instead).`,
    );
  for (const [how, ms] of derivations) notes.push(`Derived (${how}): ${[...ms].join(", ")}`);
  if (mode === "quarterly" && out.some((r) => r.derived_period)) notes.push("Q4 rows (derived_period) = FY minus 9-month YTD for flow metrics; EPS is not derived.");
  let hint: string | undefined;
  if (!out.length) {
    notes.push("No periods found for this company/mode in XBRL companyfacts.");
    // e.g. a recent IPO / new registrant that has filed 10-Qs but no 10-K yet (or the reverse).
    const other = mode === "annual" ? "quarterly" : "annual";
    const n = buildPeriods(cf, other).length;
    if (n)
      hint =
        mode === "annual"
          ? `This company has only quarterly (10-Q) XBRL data so far (${n} quarter(s)); call get_financials with period_type: 'quarterly'.`
          : `This company has no 10-Q quarters in XBRL, only annual data (${n} year(s)); call get_financials with period_type: 'annual'.`;
  }
  const latestAnnual = (mode === "annual" ? periods : annualPeriods)[0];

  return {
    cik: padCik(cf.cik),
    name: cf.entityName,
    period_type: mode,
    period_basis: "fiscal",
    fiscal_year_end: latestAnnual?.end.slice(5),
    currency,
    periods: out,
    tags_used: tagsUsed,
    notes,
    hint,
    source_url: companyFactsUrl(cf.cik),
  };
}

export async function getFinancials(cik: string, mode: "annual" | "quarterly", limit: number, metrics?: string[]): Promise<FinancialsResult> {
  const key = `fin:${cik}:${mode}:${limit}:${(metrics ?? []).join(",")}`;
  return derived(key, TTL.companyFacts, async () => computeFinancials(await getCompanyFacts(cik), mode, limit, metrics));
}
