import { COLORADO_DISCLAIMER, STATE_SOURCES, UNSUPPORTED_NOTES } from "./states/registry.js";

function build(): string {
  const lines: string[] = [];
  lines.push("# Data sources & licenses", "");
  lines.push(
    "This software (MIT) contains no data; it queries official public sources at request time. Upstream terms below were reviewed on 2026-10-20. Re-verify periodically; terms can change.",
    "",
  );
  lines.push("## SEC EDGAR (all SEC tools)", "");
  lines.push(
    "- Endpoints: `www.sec.gov/files/company_tickers_exchange.json`, `data.sec.gov/submissions/`, `data.sec.gov/api/xbrl/{companyfacts,companyconcept,frames}/`, `www.sec.gov/Archives/edgar/data/`.",
    "- Terms: U.S. federal government public information. SEC: \"Information presented on www.sec.gov is considered public information and may be copied or further distributed by users of the web site without the SEC's permission\" (cite the SEC as source). https://www.sec.gov/about/privacy-information#dissemination",
    "- Fair access: max 10 requests/second and a declared User-Agent with contact info. https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data . This server throttles to 6 req/s by default (SEC_MAX_RPS, max 8), fleet-wide via a Redis token bucket when Redis is configured; a call that gets no token in time is refused. If Redis itself errors, each instance degrades to DEGRADED_SEC_RPS (default 0.2 req/s, API-key callers; anonymous callers are served from cache only) and refuses SEC calls only when DEGRADED_SEC_RPS is 0. It always sends SEC_USER_AGENT, and refuses SEC calls when SEC_USER_AGENT is unset.",
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
    "State registries are public records, but some fields identify natural persons. What this server returns:",
    "",
    "- **Registered agents / service-of-process contacts**: commercial and organizational agents (e.g. registered-agent companies) are returned. Agents that appear to be individuals (CO and OR mark person-name fields; NY is classified heuristically) are returned as `{ kind: \"individual\", withheld: true }`. The hosted endpoint always withholds them (automated classification; contact the operator to suppress any it misses); `include_agent_details: true` reveals them only in local stdio use or on a self-hosted server with `ALLOW_PERSON_AGENT_DETAILS=1` (verified API-key callers).",
    "- **Entity addresses** (principal/mailing) are returned as published; for very small businesses these can be a person's home address.",
    "- **PA officer names** are dropped (the source is row-per-officer; rows are de-duplicated without names).",
    "- **SEC Form 4 insiders**: get_insider_trades returns reporting owners' names, roles and transactions. These are statutory public disclosures (Section 16, Securities Exchange Act) and are needed for the tool's purpose.",
    "- **Erasure / objection requests**: operators can suppress an entity's personal fields (`entity:<STATE>:<id>`) or an agent name (`agent:<name>`) via the built-in list (src/states/suppression-list.ts), a JSON file (SUPPRESSION_FILE) or the Redis set managed with `scripts/suppress.ts`. Suppressed data is never returned, even with include_agent_details.",
    "- **Hosted rate-limit state**: only integer counters keyed by a daily-rotating HMAC of the client IP (or the public API key id), with TTL equal to the enforced window (25 h per day; per-minute limits are in memory only). API key records hold only a creation date and optional limits (no owner name or contact) and can be deleted with scripts/delete-key.ts. No raw IPs, user agents, paths or tool arguments are stored in Redis or written to logs. Individual registered agents, and related entity addresses, are withheld on the hosted endpoint. See docs/OPERATIONS.md > What the hosted server stores.",
    "- Do not use registry data for FCRA-regulated decisions (credit, employment, tenancy, insurance) or other purposes prohibited by the source portals.",
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
