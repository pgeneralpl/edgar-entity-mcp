/**
 * Metric names shared by get_financials and compare_companies, plus friendly aliases.
 * Pure data (no I/O) so the quota estimator can import it.
 */

/** Friendly / alternative names → canonical metric key. */
export const METRIC_ALIASES: Readonly<Record<string, string>> = {
  revenues: "revenue",
  sales: "revenue",
  net_sales: "revenue",
  total_revenue: "revenue",
  turnover: "revenue",
  net_profit: "net_income",
  profit: "net_income",
  earnings: "net_income",
  net_earnings: "net_income",
  eps: "eps_diluted",
  diluted_eps: "eps_diluted",
  basic_eps: "eps_basic",
  operating_profit: "operating_income",
  cfo: "operating_cash_flow",
  cash_from_operations: "operating_cash_flow",
  capital_expenditures: "capex",
  fcf: "free_cash_flow",
  assets: "total_assets",
  liabilities: "total_liabilities",
  equity: "stockholders_equity",
  shareholders_equity: "stockholders_equity",
  cash_and_equivalents: "cash",
  debt: "long_term_debt",
  shares: "shares_outstanding",
};

export const canonicalMetric = (m: string): string => METRIC_ALIASES[m] ?? m;

export interface FrameMetric {
  kind: "duration" | "instant";
  /** SEC frames unit path segment. */
  unit: string;
  /** "taxonomy:Tag", tried in order; a company's value comes from the first tag it reports. */
  tags: { ref: string; untilYear?: number }[];
}

/**
 * Tags tried by compare_companies (frames API). At most MAX_FRAME_TAGS per metric: every tag is one
 * large frames download (all filers), so the list is the few tags that cover most US-GAAP filers.
 */
export const MAX_FRAME_TAGS = 3;
export const FRAME_METRICS: Readonly<Record<string, FrameMetric>> = {
  revenue: {
    kind: "duration",
    unit: "USD",
    tags: [
      { ref: "us-gaap:Revenues" },
      { ref: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" },
      // superseded by ASC 606 (2018); its frames are empty for later years
      { ref: "us-gaap:SalesRevenueNet", untilYear: 2018 },
    ],
  },
  gross_profit: { kind: "duration", unit: "USD", tags: [{ ref: "us-gaap:GrossProfit" }] },
  operating_income: { kind: "duration", unit: "USD", tags: [{ ref: "us-gaap:OperatingIncomeLoss" }] },
  net_income: {
    kind: "duration",
    unit: "USD",
    tags: [{ ref: "us-gaap:NetIncomeLoss" }, { ref: "us-gaap:ProfitLoss" }, { ref: "us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic" }],
  },
  eps_basic: { kind: "duration", unit: "USD-per-shares", tags: [{ ref: "us-gaap:EarningsPerShareBasic" }, { ref: "us-gaap:EarningsPerShareBasicAndDiluted" }] },
  eps_diluted: { kind: "duration", unit: "USD-per-shares", tags: [{ ref: "us-gaap:EarningsPerShareDiluted" }, { ref: "us-gaap:EarningsPerShareBasicAndDiluted" }] },
  operating_cash_flow: {
    kind: "duration",
    unit: "USD",
    tags: [{ ref: "us-gaap:NetCashProvidedByUsedInOperatingActivities" }, { ref: "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations" }],
  },
  capex: {
    kind: "duration",
    unit: "USD",
    tags: [{ ref: "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment" }, { ref: "us-gaap:PaymentsToAcquireProductiveAssets" }],
  },
  total_assets: { kind: "instant", unit: "USD", tags: [{ ref: "us-gaap:Assets" }] },
  total_liabilities: { kind: "instant", unit: "USD", tags: [{ ref: "us-gaap:Liabilities" }] },
  stockholders_equity: {
    kind: "instant",
    unit: "USD",
    tags: [{ ref: "us-gaap:StockholdersEquity" }, { ref: "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest" }],
  },
  cash: {
    kind: "instant",
    unit: "USD",
    tags: [{ ref: "us-gaap:CashAndCashEquivalentsAtCarryingValue" }, { ref: "us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents" }],
  },
  long_term_debt: { kind: "instant", unit: "USD", tags: [{ ref: "us-gaap:LongTermDebtNoncurrent" }, { ref: "us-gaap:LongTermDebt" }] },
};

export const FRAME_METRIC_KEYS = Object.keys(FRAME_METRICS);
/** Inputs accepted by compare_companies `metric`: canonical keys plus aliases of them. */
export const FRAME_METRIC_INPUTS = [...FRAME_METRIC_KEYS, ...Object.keys(METRIC_ALIASES).filter((k) => FRAME_METRICS[METRIC_ALIASES[k]!])];

/** Tags compare_companies will try for `metric` in calendar year `year` (≤ MAX_FRAME_TAGS). */
export function frameTagsFor(metric: string, year?: number): string[] {
  const m = FRAME_METRICS[canonicalMetric(metric)];
  if (!m) return [];
  return m.tags
    .filter((t) => year === undefined || t.untilYear === undefined || year <= t.untilYear)
    .slice(0, MAX_FRAME_TAGS)
    .map((t) => t.ref);
}

/** Tag of any metric (case-insensitive), for correcting get_xbrl_concept input without a request. */
export function knownTagCase(taxonomy: string, tag: string): string | undefined {
  const want = `${taxonomy}:${tag}`.toLowerCase();
  for (const m of Object.values(FRAME_METRICS)) for (const t of m.tags) if (t.ref.toLowerCase() === want) return t.ref.split(":")[1];
  return undefined;
}
