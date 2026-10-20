# Upstream data licenses (per source)

The code in this repository is MIT-licensed (see `/LICENSE`). It ships **no data**; every response is fetched live from the sources below. Full table with dataset ids and coverage: [`/DATA_SOURCES.md`](../DATA_SOURCES.md) (generated from `src/states/registry.ts` and `src/dataSources.ts`).

Reviewed 2026-10-20. Re-check before a commercial launch.

| Source | License / terms | Commercial use | Evidence |
|---|---|---|---|
| SEC EDGAR (www.sec.gov, data.sec.gov) | U.S. government public information; fair-access policy (≤10 req/s, declared User-Agent) | Yes | https://www.sec.gov/about/privacy-information#dissemination · https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data |
| New York — data.ny.gov `n9v6-gdp6` | OPEN-NY Terms of Use (no attribution, share-alike or pre-approval; lawful use) | Yes | https://data.ny.gov/download/77gx-ii52/application/pdf |
| Colorado — data.colorado.gov `4ykn-tg5h` | Dataset license: Public Domain; portal ToS requires the State of Colorado disclaimer in applications | Yes, with disclaimer | https://data.colorado.gov/d/4ykn-tg5h · https://data.colorado.gov/terms |
| Oregon — data.oregon.gov `tckn-sxa6` | Public domain by statute, ORS 276A.368(3); no use restrictions, ORS 276A.356(1)(c) | Yes | https://oregon.public.law/statutes/ors_276a.368 · https://oregon.public.law/statutes/ors_276a.356 |
| Connecticut — data.ct.gov `n7gp-d28j` | Dataset license: Public Domain; CT open data = no use restrictions (CGS 4-67o) | Yes | https://data.ct.gov/d/n7gp-d28j · https://data.ct.gov/terms · https://portal.ct.gov/-/media/CT-Data/Data-Publication-Guidelines.pdf |
| Pennsylvania — data.pa.gov `xvd7-5r2c` | Dataset license: Public Domain U.S. Government | Yes | https://data.pa.gov/d/xvd7-5r2c · https://www.usa.gov/government-works |

## Colorado disclaimer (must be displayed by applications using CO data)

> The data made available here has been modified for use from its original source, which is the State of Colorado. THE STATE OF COLORADO MAKES NO REPRESENTATIONS OR WARRANTY AS TO THE COMPLETENESS, ACCURACY, TIMELINESS, OR CONTENT OF ANY DATA MADE AVAILABLE THROUGH THIS SITE. THE STATE OF COLORADO EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the Web feed is being used at one's own risk.

It is also returned by the `list_supported_states` tool, shown in `public/index.html`, and summarized in every `lookup_business_entity` response that includes CO.

## Third-party npm dependencies

Runtime dependencies are permissively licensed (`@modelcontextprotocol/server` Apache-2.0, `mcp-handler` Apache-2.0, `zod` MIT, `@upstash/redis` MIT, `lru-cache` BlueOak-1.0.0, `fast-xml-parser` MIT, `html-to-text` MIT). Run `npx license-checker --production --summary` before publishing.
