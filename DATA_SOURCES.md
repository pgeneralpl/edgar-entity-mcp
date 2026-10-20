# Data sources & licenses

This software (MIT) contains no data; it queries official public sources at request time. Upstream terms below were reviewed on 2026-10-20. Re-verify before commercial launch; terms can change.

## SEC EDGAR (all SEC tools)

- Endpoints: `www.sec.gov/files/company_tickers_exchange.json`, `data.sec.gov/submissions/`, `data.sec.gov/api/xbrl/{companyfacts,companyconcept,frames}/`, `www.sec.gov/Archives/edgar/data/`.
- Terms: U.S. federal government public information. SEC: "Information presented on www.sec.gov is considered public information and may be copied or further distributed by users of the web site without the SEC's permission" (cite the SEC as source). https://www.sec.gov/about/privacy-information#dissemination
- Fair access: max 10 requests/second and a declared User-Agent with contact info. https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data . This server throttles to 6 req/s by default (SEC_MAX_RPS, max 8; fleet-wide token bucket when Redis is configured, failing closed), always sends SEC_USER_AGENT, and refuses SEC calls when SEC_USER_AGENT is unset.
- Filings themselves are documents authored by the filers; quoting for research is customary, but republishing large verbatim excerpts commercially is the operator's responsibility.

## State business-entity registries (lookup_business_entity)

| State | Dataset | Coverage | License / terms | Commercial use |
|---|---|---|---|---|
| NY | [n9v6-gdp6](https://data.ny.gov/d/n9v6-gdp6) Active Corporations: Beginning 1800 (NYS Department of State, Division of Corporations) | ACTIVE entities only (corporations, LLCs, LPs, not-for-profits). Inactive/dissolved entities are not included. | [OPEN-NY Terms of Use](https://data.ny.gov/download/77gx-ii52/application/pdf) | Permitted. OPEN-NY terms allow any lawful use including commercial; no attribution or share-alike required. |
| CO | [4ykn-tg5h](https://data.colorado.gov/d/4ykn-tg5h) Business Entities in Colorado (Colorado Department of State) | All entities incl. dissolved/delinquent (status field), since 1864. | [Public Domain (dataset metadata) + Colorado Information Marketplace Terms of Service](https://data.colorado.gov/terms) | Permitted. Dataset is marked Public Domain. The portal ToS requires applications using the data to display the State of Colorado disclaimer (included in README/DATA_SOURCES and list_supported_states). |
| OR | [tckn-sxa6](https://data.oregon.gov/d/tckn-sxa6) Active Businesses - ALL (Oregon Secretary of State, Corporation Division) | ACTIVE businesses only (incl. assumed business names). One row per associated name (address/agent/officer), grouped here by registry number. | [Public domain by statute (ORS 276A.368(3): 'All publishable data is in the public domain')](https://oregon.public.law/statutes/ors_276a.368) | Permitted. Oregon open-data statute places portal data in the public domain and forbids use restrictions (ORS 276A.356(1)(c)). |
| CT | [n7gp-d28j](https://data.ct.gov/d/n7gp-d28j) Connecticut Business Registry - Business Master (Office of the Secretary of the State) | All registered businesses incl. inactive/dissolved/forfeited (status field). | [Public Domain (dataset metadata); CT Open Data Portal terms](https://data.ct.gov/terms) | Permitted. Dataset is marked Public Domain; CT open data is defined by statute (CGS 4-67o) as having no restrictions governing use. |
| PA | [xvd7-5r2c](https://data.pa.gov/d/xvd7-5r2c) Registered Businesses in PA Current by County (PA Department of State) | Currently registered businesses only, with PA address. Row-per-officer in source; de-duplicated here (officer names omitted). | [Public Domain U.S. Government (dataset metadata)](https://www.usa.gov/government-works) | Permitted. Dataset is marked 'Public Domain U.S. Government' on data.pa.gov. |

### Required Colorado disclaimer

> The data made available here has been modified for use from its original source, which is the State of Colorado. THE STATE OF COLORADO MAKES NO REPRESENTATIONS OR WARRANTY AS TO THE COMPLETENESS, ACCURACY, TIMELINESS, OR CONTENT OF ANY DATA MADE AVAILABLE THROUGH THIS SITE. THE STATE OF COLORADO EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the Web feed is being used at one's own risk.

Source: https://data.colorado.gov/terms ("Applications using data supplied by this site must include the following disclaimers on their sites").

### Personal data note

State registries are public records, but some fields identify natural persons. What this server returns:

- **Registered agents / service-of-process contacts**: commercial and organizational agents (e.g. registered-agent companies) are returned. Agents that appear to be individuals (CO and OR mark person-name fields; NY is classified heuristically) are returned as `{ kind: "individual", withheld: true }` unless the caller passes `include_agent_details: true`.
- **Entity addresses** (principal/mailing) are returned as published; for very small businesses these can be a person's home address.
- **PA officer names** are dropped (the source is row-per-officer; rows are de-duplicated without names).
- **SEC Form 4 insiders**: get_insider_trades returns reporting owners' names, roles and transactions. These are statutory public disclosures (Section 16, Securities Exchange Act) and are needed for the tool's purpose.
- **Erasure / objection requests**: operators can suppress an entity's personal fields (`entity:<STATE>:<id>`) or an agent name (`agent:<name>`) via the built-in list (src/states/suppression-list.ts), a JSON file (SUPPRESSION_FILE) or the Redis set managed with `scripts/suppress.ts`. Suppressed data is never returned, even with include_agent_details.
- Do not use registry data for FCRA-regulated decisions (credit, employment, tenancy, insurance) or other purposes prohibited by the source portals.

### Investigated but not enabled

- **DE**: Delaware (most large US corporations) offers no open bulk data; the Division of Corporations search is web-only with paid status/document fees. Roadmap: link-out only.
- **CA**: California bizfile offers a public API (api.sos.ca.gov) requiring registration/subscription key; not an open-license dataset. Roadmap.
- **FL**: Florida Sunbiz publishes bulk data files via SFTP (public records); not a SODA API. Roadmap.

## Socrata (Tyler Technologies) SODA API

All state datasets are served via Socrata SODA 2.x endpoints. Anonymous requests are throttled per IP; set SOCRATA_APP_TOKEN (free at each portal's developer settings) for higher limits. https://dev.socrata.com/docs/app-tokens.html
