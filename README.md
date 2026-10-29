# edgar-entity-mcp

[![npm](https://img.shields.io/npm/v/edgar-entity-mcp.svg)](https://www.npmjs.com/package/edgar-entity-mcp) [![CI](https://github.com/pgeneralpl/edgar-entity-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pgeneralpl/edgar-entity-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Source: https://github.com/pgeneralpl/edgar-entity-mcp · Issues: https://github.com/pgeneralpl/edgar-entity-mcp/issues · npm: https://www.npmjs.com/package/edgar-entity-mcp · MCP Registry: [`io.github.pgeneralpl/edgar-entity-mcp`](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.pgeneralpl/edgar-entity-mcp)

**US company research for AI agents, from official public data.** One MCP server that covers SEC EDGAR (filings, XBRL financials, Form 4 insider trades, cross-company comparisons) and state Secretary of State business-entity registries (NY, CO, OR, CT, PA). Responses are compact JSON with source URLs, sized to keep token use low.

- **Analysts**: "Compare TSLA, F and GM revenue for CY2023", "What did insiders sell at Apple this month?", "Summarize the latest 10-K risk factors."
- **Founders / sales / diligence**: "Is *Acme Widgets LLC* an active Colorado entity? Who is its registered agent?"
- **Researchers**: clean 10-K/10-Q sections as text, normalized financial time series with the XBRL tag used for each metric.

No API keys are needed for the data. SEC asks you to identify yourself with a User-Agent (see [SEC User-Agent](#sec-user-agent-and-rate-limits)).

```
npx -y edgar-entity-mcp        # stdio MCP server
```

---

## Tools

| Tool | What it does | Source |
|---|---|---|
| `search_company` | Ticker/name → CIK matches, fuzzy-ranked (share classes merged) | `company_tickers_exchange.json` |
| `get_company_profile` | Name, tickers, exchanges, SIC + industry, state of incorporation, FYE, EIN, addresses, former names, latest 10-K/10-Q | `data.sec.gov/submissions` |
| `list_filings` | Filings by form type + date range, with accession, dates, primary-document and index URLs; reads older history pages when needed | `data.sec.gov/submissions` |
| `get_filing_document` | Primary document converted to clean text (tables kept as rows); 10-K/10-Q **item extraction** (1, 1A, 7, 7A, 8…); `max_chars`/`offset` paging | `www.sec.gov/Archives` |
| `get_financials` | Normalized revenue, gross profit, operating income, net income, EPS (basic/diluted), assets, liabilities, equity, cash, long-term debt, operating cash flow, capex, FCF, shares outstanding; annual or quarterly; deduped by fiscal period; reports the **tag used** | XBRL `companyfacts` |
| `get_xbrl_concept` | Full history of any XBRL concept/unit for one company | XBRL `companyconcept` |
| `compare_companies` | One concept across all filers for a calendar period (rank or filter by tickers) | XBRL `frames` |
| `get_insider_trades` | Form 4/4A parsed: reporter, role/title, code + plain meaning, shares, price, value, A/D, owned after, derivative details; buy/sell summary | Form 4 XML |
| `lookup_business_entity` | Search SoS registries by name or entity id; normalized status, type, formation date, jurisdiction, addresses, registered agent | NY/CO/OR/CT/PA open data (Socrata) |
| `list_supported_states` | Coverage, dataset ids, update cadence and license per state | — |

Also included: a `company_research_brief` **prompt** that runs the whole workflow, and an `edgar-entity://data-sources` **resource** (licenses).

Every tool takes `company` as a ticker (`AAPL`), CIK (`320193`) or unambiguous name. Errors come back as `{"error":{"code","message","hint"}}` with `isError: true`. Ambiguous names return candidate CIKs.

### Example calls and real outputs (live data, trimmed)

**`get_financials`** `{"company":"AAPL","limit":1}`
```json
{"cik":"0000320193","name":"Apple Inc.","period_type":"annual","currency":"USD",
 "periods":[{"fy":2025,"fp":"FY","period_end":"2025-09-27","period_start":"2024-09-29","form":"10-K","filed":"2025-10-31",
   "accession":"0000320193-25-000079","revenue":416161000000,"gross_profit":195201000000,"operating_income":133050000000,
   "net_income":112010000000,"eps_basic":7.49,"eps_diluted":7.46,"operating_cash_flow":111482000000,"capex":12715000000,
   "total_assets":359241000000,"total_liabilities":285508000000,"stockholders_equity":73733000000,"cash":35934000000,
   "long_term_debt":78328000000,"shares_outstanding":14776353000,"free_cash_flow":98767000000}],
 "tags_used":{"revenue":["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"],"net_income":["us-gaap:NetIncomeLoss"],"...":[]},
 "source_url":"https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"}
```
`period_type:"quarterly"` returns 3-month values. 10-Q cash-flow lines are year-to-date, so quarters are derived by differencing, and Q4 is derived as FY minus 9M. For example, MSFT FY25 Q4 revenue comes out at $76.441B, which matches the reported figure. Each derived value is listed in `notes`.

**`get_insider_trades`** `{"company":"TSLA","limit":5}`
```json
{"cik":"0001318605","name":"Tesla, Inc.","filings_returned":5,
 "summary":{"open_market_buys":{"count":0,"shares":0,"value":0},"open_market_sales":{"count":19,"shares":34620.25,"value":13321733}},
 "code_legend":{"F":"Shares withheld to pay exercise price or taxes","M":"Exercise or conversion of derivative (exempt)","S":"Open market or private sale"},
 "filings":[{"form":"4","filed":"2026-09-09","accession":"0001104659-26-106432","reporter":"Taneja Vaibhav","roles":"Officer",
   "officer_title":"Chief Financial Officer","transactions":[
     {"security":"Common Stock","date":"2026-09-08","code":"S","shares":2605.75,"price":360.134,"value":938419.17,
      "acquired_disposed":"D","shares_owned_after":25972.25,"ownership":"D"}],
   "url":"https://www.sec.gov/Archives/edgar/data/1318605/000110465926106432/tm2625055d1_4seq1.xml"}],"has_more":true}
```

**`get_filing_document`** `{"url":"https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm","section":"1A","max_chars":3000}`
```json
{"url":"…/aapl-20250927.htm","kind":"html","section":{"id":"1A","title":"Risk Factors"},"total_chars":68118,"offset":0,"next_offset":3000,
 "text":"Item 1A.  Risk Factors\nThe following summarizes factors that could have a material adverse effect on the Company’s business…"}
```

**`compare_companies`** `{"tag":"Revenues","period":"CY2023","companies":["TSLA","F","GM"]}`
```json
{"concept":"us-gaap:Revenues","unit":"USD","period":"CY2023","companies_reporting":2679,"results":[
 {"rank":12,"cik":"0000037996","name":"Ford Motor Co","val":176191000000,"end":"2023-12-31"},
 {"rank":13,"cik":"0001467858","name":"GENERAL MOTORS COMPANY","val":171842000000,"end":"2023-12-31"},
 {"rank":23,"cik":"0001318605","name":"Tesla, Inc.","val":96773000000,"end":"2023-12-31"}],
 "source_url":"https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2023.json"}
```
Balance-sheet (instant) concepts need an `I` suffix, e.g. `{"tag":"Assets","period":"CY2024Q4I"}`.

**`lookup_business_entity`** `{"name":"Newmont Corporation","states":["CO"]}`
```json
{"results":[{"state":"CO","entity_id":"20021056790","name":"Newmont Corporation","status":"Good Standing",
  "type":"Foreign Profit Corporation (FPC)","formed":"2002-03-08","jurisdiction":"DE",
  "principal_address":"6900 East Layton Ave, Suite 700, Denver, CO, 80237, US",
  "registered_agent":{"name":"CORPORATION SERVICE COMPANY","address":"1900 W Littleton Blvd, Littleton, CO, 80120"},
  "details_url":"https://www.coloradosos.gov/biz/BusinessEntityDetail.do?masterFileId=20021056790",
  "source_url":"https://data.colorado.gov/resource/4ykn-tg5h.json?entityid=20021056790"}],
 "by_state":{"CO":{"count":1,"query_url":"…"}}}
```

Other quick examples:
- `search_company {"query":"berkshire"}` → `BERKSHIRE HATHAWAY INC`, CIK `0001067983`, tickers `BRK-B, BRK-A`
- `list_filings {"company":"AAPL","forms":["10-K"],"date_to":"2010-12-31","limit":2}` → the 2010 10-K and 10-K/A, read from older history pages
- `get_xbrl_concept {"company":"TSLA","tag":"ResearchAndDevelopmentExpense","forms":["10-K"],"framed_only":true}`
- `lookup_business_entity {"entity_id":"0783036","states":["CT"]}` → THE TRAVELERS COMPANIES, INC. (Active, foreign stock corp, MN)

---

## Install

Three ways to connect: the hosted endpoint `https://edgar-entity-mcp.vercel.app/mcp` (no install, see *Remote* below), the npm package [`edgar-entity-mcp`](https://www.npmjs.com/package/edgar-entity-mcp) over stdio (**Node.js ≥ 22.23.4 or ≥ 24.22.1**), or any client that installs from the official [MCP Registry](https://registry.modelcontextprotocol.io) entry `io.github.pgeneralpl/edgar-entity-mcp`.

Quick check: `npx -y edgar-entity-mcp --version`

> **Node.js version (stdio users):** run the package on a patched Node.js — **22.23.4+ (22.x) or 24.22.1+ (24.x, recommended)**, or 26.12.1+. These releases (2026-10-21) fix CVE-2026-111497, a Brotli decoder out-of-bounds write that a malicious server response decoded by `fetch()` could trigger, plus TLS hostname-verification bypasses. Node.js 20 is end-of-life and will not get the fix. Check with `node -v`; the server prints a warning on stderr when started on an unpatched Node.js. The hosted endpoint runs on Vercel's managed Node.js 24.x runtime, which Vercel patches itself. `engines.node` is `24.x` (it pins the Vercel runtime), so npm prints an `EBADENGINE` notice on 22.x — that is expected and harmless on 22.23.4+.

### Claude Desktop / Claude Code / Cursor / Windsurf / VS Code (stdio via npx)

```json
{
  "mcpServers": {
    "edgar-entity": {
      "command": "npx",
      "args": ["-y", "edgar-entity-mcp"],
      "env": { "SEC_USER_AGENT": "Your Name or Company you@example.com" }
    }
  }
}
```
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
- **Cursor**: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).
- **Claude Code**: `claude mcp add edgar-entity -e SEC_USER_AGENT="Your Name you@example.com" -- npx -y edgar-entity-mcp`
- **VS Code**: `.vscode/mcp.json` using `"servers"` in place of `"mcpServers"`.

### Remote (Streamable HTTP)

Hosted endpoint (free, no key needed): `https://edgar-entity-mcp.vercel.app/mcp` · health: https://edgar-entity-mcp.vercel.app/health. The hosted instance uses Upstash Redis for a shared cache, a fleet-wide SEC budget of 6 req/s, and per-client quotas (see [Hosted limits](#hosted-limits)).

```json
{ "mcpServers": { "edgar-entity": { "url": "https://edgar-entity-mcp.vercel.app/mcp" } } }
```
For clients that only speak stdio: `"command": "npx", "args": ["-y", "mcp-remote", "https://edgar-entity-mcp.vercel.app/mcp"]`.

### Self-host the HTTP server

```bash
npm run build && PORT=3000 SEC_USER_AGENT="Acme you@acme.com" npm run start:http   # → http://127.0.0.1:3000/mcp
```

The node server binds `127.0.0.1` by default and only answers requests whose `Host` is localhost (DNS-rebinding protection) and whose `Origin`, if any, is local. To expose it, set `HOST=0.0.0.0`, `ALLOWED_HOSTS=mcp.example.com`, optionally `ALLOWED_ORIGINS`, and `TRUST_PROXY=1` only when a reverse proxy sets `X-Forwarded-For`/`X-Real-IP`. All settings are listed under [Environment variables](docs/OPERATIONS.md#environment-variables).

### Deploy to Vercel

The repo already contains `api/mcp.ts` and `api/health.ts` (Vercel Functions with a Web-standard handler built on [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)) and `vercel.json`, which runs `npm run build` and rewrites `/mcp` to `/api/mcp` and `/health` to `/api/health`. It also sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` on every response, and a strict `Content-Security-Policy` (`default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`) on the static HTML pages only (`/`, `/privacy`, `/terms`, `/abuse`), not on `/mcp` or `/health`. `public/llms.txt` (a plain-text summary for LLM tools and crawlers) is served at `/llms.txt` as `text/plain; charset=utf-8`. `npm run smoke:remote -- https://<project>.vercel.app/mcp` runs a live check against a deployment.

1. `vercel link` then `vercel env add SEC_USER_AGENT` (plus `HEALTH_SECRET`, `IP_HASH_SALT`, optionally `SOCRATA_APP_TOKEN`; full list in [Production configuration](docs/OPERATIONS.md#production-configuration)).
2. Strongly recommended: add the **Upstash Redis** integration. The cache, the SEC/state rate budgets and the per-client quotas then become fleet-wide; without it they are per instance. Keep **eviction off** in the Upstash console and enable usage alerts: the cache bounds itself (see [Redis memory budget](docs/OPERATIONS.md#redis-memory-budget)).
3. `vercel deploy --prod`. Point clients at `https://<project>.vercel.app/mcp`.

---

## Hosted limits

The hosted endpoint is a free beta with low limits. Anonymous clients get **60 units per day per IP and 30 per minute**, within shared daily budgets per network and for all anonymous use; most calls cost 1–3 units and a call answered from cache costs 1. Over-quota calls return a `RATE_LIMITED` error with `retry_after_seconds`. Running locally via `npx -y edgar-entity-mcp` has no quota. Need higher limits? Open an issue: https://github.com/pgeneralpl/edgar-entity-mcp/issues

Other limits on the HTTP endpoint: 64 KB request bodies, no JSON-RPC batches (one message per request), at most 20 Form 4 filings per insider call and 5 states / 25 results per state per entity lookup, filing documents up to 15 MB.

Environment variables, unit costs per tool, quota internals, the Upstash and Redis budgets, and the production configuration are documented for operators and self-hosters in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Privacy and personal data

The hosted server's [Privacy Policy](https://edgar-entity-mcp.vercel.app/privacy) ([source](public/privacy.html)), [Beta terms](https://edgar-entity-mcp.vercel.app/terms) ([source](public/terms.html)) and [Contact & Abuse](https://edgar-entity-mcp.vercel.app/abuse) ([source](public/abuse.html)) pages are served from `public/`. The only contact is patryk.general@mail.grokbot.com.

- Registered agents and service-of-process contacts are treated as **individuals unless the name ends with a legal-form suffix** (Inc, Corp, LLC, LLP, LP, Ltd, Company, "& Co", Bank, N.A., …) or is a known registered-agent service (CT Corporation, CSC, Cogency Global, …). "JOHN CHURCH", "JUDE LAW", "DAVID CO" and "JOHN SMITH PA" are individuals; ambiguous CO/PA/PC endings count as individual.
- Individual agents are returned as `{ "kind": "individual", "withheld": true }`, and the entity's principal/mailing addresses (and NY location name) are withheld too (`addresses_withheld: true`), since for one-person businesses these are often a home address. `include_agent_details: true` reveals them in local stdio use; anonymous callers of the hosted endpoint get a privacy note instead. Organizational agents are always shown.
- Erasure/objection requests: add `entity:<STATE>:<id>` or `agent:<name>` with `npx tsx scripts/suppress.ts add ...` (Redis set, picked up within 10 minutes), `SUPPRESSION_FILE`, or `src/states/suppression-list.ts`. Entity ids are normalized (case, punctuation, leading zeros). A suppressed name is matched as whole words in agent names and addresses **and** in the entity name, NY location name and principal/mailing addresses; any hit removes every personal field of that record, and a hit in the entity name (also matched with spaces removed, e.g. "JANEDOE HOLDINGS LLC") replaces the name with `[withheld]`. If Redis is configured but the suppression list cannot be loaded on a cold instance, state lookups are refused (before any registry request) rather than served without it.
- Form 4 reporting-owner names are statutory public disclosures and are returned by `get_insider_trades`.

### What the hosted server stores, and for how long

- Rate limiting keeps **only integer counters** in Redis, under identifiers hashed with a salt that rotates daily, expiring 25 h after the UTC day they count; per-minute limits stay in process memory.
- Not stored anywhere in Redis: raw IPs, user agents, request paths, tool arguments, per-tool usage history. Shared cache entries hold public SEC and state data under hashed key names and expire after at most 24 h.
- Aggregate usage statistics (per-day counts per tool, outcome and error code, allowlisted client-software labels, an approximate unique-client count) are kept for 30 days after each UTC day; no per-client records.
- Logs (errors, and optional per-call usage lines with a daily-rotating hash) go to Vercel runtime logs under Vercel's plan retention; tool arguments and raw IPs are never logged by this server.

The full Redis key list, TTLs and hashing scheme are in [docs/OPERATIONS.md](docs/OPERATIONS.md#what-the-hosted-server-stores-and-for-how-long).

## Security notes

- Filing text from `get_filing_document` is untrusted, filer-authored content. It is returned between `<<<BEGIN UNTRUSTED SEC FILING TEXT id=<nonce>>>>` / `<<<END UNTRUSTED SEC FILING TEXT id=<nonce>>>>` markers, where the nonce is random per response and repeated in `untrusted_marker_id`, so filer text cannot fake a closing marker. Zero-width, bidi control, Unicode tag characters (U+E0000–E007F) and variation selectors (U+FE00–FE0F, U+E0100–E01EF) are stripped. Other third-party text (entity names and addresses, Form 4 reporter names, remarks and footnotes, XBRL labels and descriptions) is cleaned the same way and listed in each response's `untrusted_fields`. Agents should treat all of it as data, never as instructions.
- Only `https://www.sec.gov/Archives/edgar/data/<CIK>/<accession>/<file>` URLs are accepted as document input; redirects are followed manually and re-checked against the host allowlist.
- Error messages returned to clients are generic; details go to server logs with a reference id.

## SEC User-Agent and rate limits

SEC's [fair-access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) caps clients at **10 requests/second** and requires a declared User-Agent. SEC may block clients without one (HTTP 403 "Undeclared Automated Tool"). This server sends `SEC_USER_AGENT` on every SEC request, stays at 6 req/s by default (fleet-wide with Redis), retries 429/5xx with backoff, and caches responses for at most 24 h. Limiter and cache details: [docs/OPERATIONS.md](docs/OPERATIONS.md#sec-rate-limiting-and-caching).

## Data sources & licenses

The code is MIT-licensed. The server ships no data and fetches everything live. Full details are in [DATA_SOURCES.md](DATA_SOURCES.md) and [LICENSES/](LICENSES/README.md).

| Source | Dataset | Coverage | License (commercial use) |
|---|---|---|---|
| SEC EDGAR | submissions, XBRL APIs, Archives | All EDGAR filers | US gov public information; [SEC policy](https://www.sec.gov/about/privacy-information#dissemination) (yes) |
| New York DOS | [`n9v6-gdp6`](https://data.ny.gov/d/n9v6-gdp6) Active Corporations | **Active** entities only, monthly | [OPEN-NY Terms](https://data.ny.gov/download/77gx-ii52/application/pdf) (yes) |
| Colorado SOS | [`4ykn-tg5h`](https://data.colorado.gov/d/4ykn-tg5h) Business Entities | All entities + status, daily | Public Domain + [CO ToS disclaimer](https://data.colorado.gov/terms) (yes) |
| Oregon SOS | [`tckn-sxa6`](https://data.oregon.gov/d/tckn-sxa6) Active Businesses | **Active** only, weekly | Public domain by statute, [ORS 276A.368](https://oregon.public.law/statutes/ors_276a.368) (yes) |
| Connecticut SOTS | [`n7gp-d28j`](https://data.ct.gov/d/n7gp-d28j) Business Master | All + status, daily | Public Domain, [CT terms](https://data.ct.gov/terms) (yes) |
| Pennsylvania DOS | [`xvd7-5r2c`](https://data.pa.gov/d/xvd7-5r2c) Registered Businesses | Current registrations, monthly | Public Domain U.S. Government (yes) |

> **Colorado disclaimer:** The data made available here has been modified for use from its original source, which is the State of Colorado. THE STATE OF COLORADO MAKES NO REPRESENTATIONS OR WARRANTY AS TO THE COMPLETENESS, ACCURACY, TIMELINESS, OR CONTENT OF ANY DATA MADE AVAILABLE THROUGH THIS SITE. THE STATE OF COLORADO EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the Web feed is being used at one's own risk.

Delaware, the most common state of incorporation, has no open bulk dataset, so it is not covered. CA and FL are on the roadmap (see `list_supported_states`). This server provides informational data only and is **not investment, legal or credit advice**. It is not a consumer reporting agency, and its output must not be used for FCRA-regulated decisions.

## Architecture

```
src/
  core/      config, cache (memory LRU | Upstash | tiered), rate limiter, fetch+retry, usage hooks, errors
  sec/       tickers (fuzzy), submissions, documents (HTML→text, item extraction), financials, xbrl (concept/frames), insider (Form 4)
  states/    registry (per-state dataset config + normalizers), socrata (SoQL builder, ranking)
  tools.ts   zod schemas + tool handlers (transport-agnostic)
  server.ts  registers tools/prompt/resource on an McpServer (shared by both transports)
  stdio.ts   npm bin  → serveStdio()
  http/      handler.ts (mcp-handler + auth/quotas) · node-server.ts (local/self-host)
api/mcp.ts   Vercel Function
```
Built on the official MCP TypeScript SDK **v2** (`@modelcontextprotocol/server`, the successor to the `@modelcontextprotocol/sdk` v1 package, and a requirement of `mcp-handler` 2.x). It serves the 2026-07-28 protocol and falls back automatically for 2025-era clients, over both stdio and HTTP.

## Development

```bash
npm install
npm run check        # typecheck + eslint + vitest (offline unit tests)
npm run smoke:e2e    # build + live smoke over stdio (all tools, real SEC/state data) + HTTP + Vercel-function e2e
npm run validate:registry   # validate server.json against the MCP Registry schema
npx @modelcontextprotocol/inspector --cli node dist/stdio.js --method tools/list
```

## Roadmap

- More states: FL (Sunbiz bulk files), CA (bizfile API, needs a key), WA/TX where open data allows; NY inactive entities (the "All Filings" dataset)
- Officers/directors (CT principals dataset; PA officer rows; DEF 14A)
- EDGAR full-text search (`efts.sec.gov`) and 8-K item-level event feed
- 13F holdings, 13D/G ownership, S-1/IPO tracking
- Webhooks/subscriptions for new filings and insider trades (MCP events)
- Segment and geographic revenue (XBRL dimensions via the Financial Statement datasets)
- MCPB bundle for one-click Claude Desktop install (a `manifest.json` is included and validated)

## License

MIT for the code (see [LICENSE](LICENSE)). Use of the hosted server is subject to the [Beta terms](https://edgar-entity-mcp.vercel.app/terms). Data remains subject to each source's terms (see [DATA_SOURCES.md](DATA_SOURCES.md)).
