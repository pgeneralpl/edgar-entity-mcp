# edgar-entity-mcp

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

Hosted URL: `https://edgar-entity-mcp.vercel.app/mcp` (this is a placeholder until the server is deployed).

```json
{ "mcpServers": { "edgar-entity": { "url": "https://edgar-entity-mcp.vercel.app/mcp" } } }
```
For clients that only speak stdio: `"command": "npx", "args": ["-y", "mcp-remote", "https://edgar-entity-mcp.vercel.app/mcp"]`. If the deployment sets `MCP_API_KEYS`, send `Authorization: Bearer <key>` or `x-api-key: <key>`.

### Self-host the HTTP server

```bash
npm run build && PORT=3000 SEC_USER_AGENT="Acme you@acme.com" npm run start:http   # → http://localhost:3000/mcp
```

### Deploy to Vercel

The repo already contains `api/mcp.ts` (a Vercel Function with a Web-standard handler built on [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)) and `vercel.json`, which runs `npm run build` and rewrites `/mcp` to `/api/mcp`.

1. `vercel link` then `vercel env add SEC_USER_AGENT` (and optionally the Upstash / `MCP_API_KEYS` variables).
2. Recommended: add the **Upstash Redis** integration. The cache is then shared across instances, and the SEC rate budget becomes fleet-wide rather than per instance.
3. `vercel deploy --prod`. Point clients at `https://<project>.vercel.app/mcp`.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SEC_USER_AGENT` | `edgar-entity-mcp/<ver> contact@example.com` | **Set this.** SEC requires a descriptive UA with contact info, e.g. `"Acme Research jane@acme.com"`. The server prints a warning to stderr while the default is in use. |
| `SEC_MAX_RPS` | `8` (max 9) | SEC requests per second, per process |
| `SEC_DISTRIBUTED_RATE_LIMIT` | `1` | With Upstash configured, also caps SEC calls across all instances, using a per-second Redis counter |
| `SOCRATA_APP_TOKEN` | – | Optional app token for state portals (higher throttling limits) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Enables the Redis cache (Vercel's `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work). Without them the cache is an in-memory LRU. |
| `MCP_API_KEYS` | – | Comma-separated keys. When set, the HTTP endpoint returns 401 to requests without a valid key. |
| `USAGE_LOG` | – | `1` logs per-call usage JSON (tool, latency, ok, response size, key prefix) to stderr |
| `MEMORY_CACHE_MB` / `REDIS_MAX_VALUE_BYTES` / `HTTP_TIMEOUT_MS` | 128 / 900000 / 25000 | Tuning |

## SEC User-Agent and rate limits

SEC's [fair-access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) caps clients at **10 requests/second** and requires a declared User-Agent. SEC may block clients without one (HTTP 403 "Undeclared Automated Tool"). This server:
- sends `SEC_USER_AGENT` on every SEC request;
- spaces requests through a global limiter at ~8 req/s by default (measured: 41 requests in 5.0s while parsing 40 Form 4s);
- retries 429/5xx with exponential backoff and respects `Retry-After`;
- deduplicates identical in-flight requests and caches with TTLs: tickers 24h, submissions 10 min, companyfacts/concepts 6h, frames 12h, filing documents 30 days (filings are immutable), state searches 1h.

## Monetization hooks (no billing yet)

- **HTTP gate**: `MCP_API_KEYS` (static keys), or `createHttpHandler({ verifyKey: async (k) => lookup(k) })` for keys stored in a database. Keys are checked with `mcp-handler`'s `withMcpAuth` and return RFC 9728-style 401 responses.
- **Per-call metering**: `setUsageHooks({ beforeCall, afterCall })` (exported from the package). `beforeCall` receives `{tool, transport, apiKey, clientId}`; throwing from it rejects the call with `UNAUTHORIZED`, which covers quotas and credits. `afterCall` receives `{ok, ms, errorCode, responseChars}`, which is enough for pay-per-call or per-token pricing.
- Suggested tiers: free (stdio or keyless HTTP, cached), Pro (API key, higher limits, bulk/paginated exports), Team (webhooks for new filings or insider trades).

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
  http/      handler.ts (mcp-handler + API-key auth) · node-server.ts (local/self-host)
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
- Hosted plan: API keys, quotas and usage dashboard (the hooks already exist)

## License

MIT for the code (see [LICENSE](LICENSE)). Data remains subject to each source's terms (see [DATA_SOURCES.md](DATA_SOURCES.md)).
