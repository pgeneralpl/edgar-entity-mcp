import { COLORADO_DISCLAIMER, STATE_SOURCES, UNSUPPORTED_NOTES } from "./states/registry.js";

function build(): string {
  const lines: string[] = [];
  lines.push("# Data sources & licenses", "");
  lines.push(
    "This software (MIT) contains no data; it queries official public sources at request time. Upstream terms below were reviewed on 2026-10-20. Re-verify before commercial launch; terms can change.",
    "",
  );
  lines.push("## SEC EDGAR (all SEC tools)", "");
  lines.push(
    "- Endpoints: `www.sec.gov/files/company_tickers_exchange.json`, `data.sec.gov/submissions/`, `data.sec.gov/api/xbrl/{companyfacts,companyconcept,frames}/`, `www.sec.gov/Archives/edgar/data/`.",
    "- Terms: U.S. federal government public information. SEC: \"Information presented on www.sec.gov is considered public information and may be copied or further distributed by users of the web site without the SEC's permission\" (cite the SEC as source). https://www.sec.gov/about/privacy-information#dissemination",
    "- Fair access: max 10 requests/second and a declared User-Agent with contact info. https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data . This server throttles to ~8 req/s (SEC_MAX_RPS) and always sends SEC_USER_AGENT.",
    "- Filings themselves are documents authored by the filers; quoting for research is customary, but republishing large verbatim excerpts commercially is the operator's responsibility.",
    "",
  );
  lines.push("## State business-entity registries (lookup_business_entity)", "");
  lines.push("| State | Dataset | Coverage | License / terms | Commercial use |", "|---|---|---|---|---|");
  for (const s of Object.values(STATE_SOURCES)) {
    lines.push(`| ${s.code} | [${s.dataset}](${s.landing_url}) ${s.dataset_name} | ${s.coverage} | [${s.license}](${s.license_url}) | ${s.commercial_use} |`);
  }
  lines.push("");
  lines.push("### Required Colorado disclaimer", "", `> ${COLORADO_DISCLAIMER}`, "");
  lines.push("Source: https://data.colorado.gov/terms (\"Applications using data supplied by this site must include the following disclaimers on their sites\").", "");
  lines.push("### Personal data note", "");
  lines.push(
    "Registries include names/addresses of registered agents and, in some states, individuals. This server returns entity-level fields only (PA officer names are dropped). Operators should honor state privacy notices and not use the data for prohibited purposes (e.g. FCRA-regulated decisions).",
    "",
  );
  lines.push("### Investigated but not enabled", "");
  for (const [k, v] of Object.entries(UNSUPPORTED_NOTES)) lines.push(`- **${k}**: ${v}`);
  lines.push("");
  lines.push("## Socrata (Tyler Technologies) SODA API", "");
  lines.push(
    "All state datasets are served via Socrata SODA 2.x endpoints. Anonymous requests are throttled per IP; set SOCRATA_APP_TOKEN (free at each portal's developer settings) for higher limits. https://dev.socrata.com/docs/app-tokens.html",
  );
  return lines.join("\n");
}

export const DATA_SOURCES_MD = build();
