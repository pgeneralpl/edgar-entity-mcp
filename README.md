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

Hosted endpoint (free, no key needed): `https://edgar-entity-mcp.vercel.app/mcp` · health: https://edgar-entity-mcp.vercel.app/health. The hosted instance uses Upstash Redis for a shared cache, a fleet-wide SEC budget of 6 req/s, and per-client quotas (see [Hosted quotas](#hosted-quotas-and-api-keys)).

```json
{ "mcpServers": { "edgar-entity": { "url": "https://edgar-entity-mcp.vercel.app/mcp" } } }
```
For clients that only speak stdio: `"command": "npx", "args": ["-y", "mcp-remote", "https://edgar-entity-mcp.vercel.app/mcp"]`. With an API key, send `Authorization: Bearer <key>` or `x-api-key: <key>` (mcp-remote: `--header "Authorization: Bearer <key>"`).

### Self-host the HTTP server

```bash
npm run build && PORT=3000 SEC_USER_AGENT="Acme you@acme.com" npm run start:http   # → http://127.0.0.1:3000/mcp
```

The node server binds `127.0.0.1` by default and only answers requests whose `Host` is localhost (DNS-rebinding protection) and whose `Origin`, if any, is local. To expose it, set `HOST=0.0.0.0`, `ALLOWED_HOSTS=mcp.example.com`, optionally `ALLOWED_ORIGINS`, and `TRUST_PROXY=1` only when a reverse proxy sets `X-Forwarded-For`/`X-Real-IP`.

### Deploy to Vercel

The repo already contains `api/mcp.ts` and `api/health.ts` (Vercel Functions with a Web-standard handler built on [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)) and `vercel.json`, which runs `npm run build` and rewrites `/mcp` to `/api/mcp` and `/health` to `/api/health`. `npm run smoke:remote -- https://<project>.vercel.app/mcp` runs a live check against a deployment.

1. `vercel link` then `vercel env add SEC_USER_AGENT` (plus `HEALTH_SECRET`, `IP_HASH_SALT`, optionally `SOCRATA_APP_TOKEN` / `MCP_API_KEYS`).
2. Strongly recommended: add the **Upstash Redis** integration. The cache, the SEC/state rate budgets and the per-client quotas then become fleet-wide; without it they are per instance. Keep **eviction off** in the Upstash console and enable usage alerts: the cache bounds itself (see [Redis memory budget](#redis-memory-budget)).
3. `vercel deploy --prod`. Point clients at `https://<project>.vercel.app/mcp`.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SEC_USER_AGENT` | – (required) | **Set this** to your own `"<Name or Company> <email>"`, e.g. `"Acme Research jane@acme.com"`. SEC tools refuse to run (`CONFIG_ERROR`) while it is unset or a placeholder; state-registry tools still work. |
| `SEC_MAX_RPS` | `6` (max 8) | SEC requests per second: per process, and fleet-wide when Redis is configured |
| `SOCRATA_MAX_RPS` | `5` | State-portal requests per second (same two-stage limiter) |
| `DISTRIBUTED_RATE_LIMIT` | `1` | `0` disables the Redis token buckets (per-process limits only) |
| `SOCRATA_APP_TOKEN` | – | App token for the state portals (higher throttling limits; free at each portal's developer settings) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Enables Redis (Vercel's `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work). Without them cache and quotas are in-memory. |
| `QUOTA_ANON_PER_MINUTE` / `QUOTA_ANON_PER_DAY` | `30` / `60` | HTTP quota for anonymous clients, in units, per hashed IP (per-minute limits are enforced per instance, in memory) |
| `QUOTA_ANON_NETWORK_PER_DAY` | 10% of the global cap (`60`) | Shared daily cap for all anonymous clients in one /24 (IPv6 /48), against address rotation; never more than 10% of `QUOTA_ANON_GLOBAL_PER_DAY` |
| `QUOTA_ANON_GLOBAL_PER_DAY` / `QUOTA_ANON_GLOBAL_HARD_PER_DAY` / `QUOTA_ANON_TRICKLE_PER_DAY` | `600` / `900` / `10` | Soft daily cap for **all** anonymous clients together; past it each IP still gets the trickle allowance, up to the hard ceiling. API-key callers are not affected. |
| `QUOTA_KEY_PER_MINUTE` / `QUOTA_KEY_PER_DAY` | `120` / `500` | HTTP quota per API key (per-key overrides via `scripts/create-key.ts`) |
| `SEC_KEYED_RESERVED_RPS` | `2` | Part of `SEC_MAX_RPS` reserved for API-key callers (anonymous traffic shares the rest) |
| `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` | `4` | Concurrent upstream fetches per client (hashed IP or key); more wait, then get `RATE_LIMITED` |
| `DEGRADED_SEC_RPS` | `0.2` (max 2) | Per-instance SEC rate for API-key callers while Redis is unavailable or over its plan limit; `0` = refuse SEC calls. Anonymous callers are cache-only in that state. |
| `MCP_API_KEYS` | – | Comma-separated static keys (accepted alongside hashed keys stored in Redis) |
| `MCP_REQUIRE_API_KEY` | – | `1` rejects anonymous HTTP calls with 401 (0.1.x required a key whenever `MCP_API_KEYS` was set) |
| `KEY_REQUEST_URL` | GitHub issue link | Shown in RATE_LIMITED hints as the place to request a free key |
| `IP_HASH_SALT` | – (**required with Redis**) | Secret (≥32 random chars, e.g. `openssl rand -hex 32`) for the IP hash. The salt actually used is `HMAC-SHA256(IP_HASH_SALT, UTC date)`, so it rotates daily. With Redis configured and this missing, set to the old default `edgar-entity-mcp`, or shorter than 32 chars, the server refuses to start (node: exit 1; Vercel: every request gets 503 and `/health` says `misconfigured`). |
| `API_KEY_SECRET` | – (**required with Redis**) | Secret (≥32 random chars, different from `IP_HASH_SALT`) used to sign API keys (`eem_<id>_<HMAC>`). Rotating it invalidates every minted key at once. Without Redis, minted keys are disabled. |
| `REVOKED_KEY_IDS` | – | Comma-separated key ids (or full keys) refused immediately on every instance, without Redis — use for urgent revocation, including during degraded mode |
| `HEALTH_SECRET` | – | Enables `/health?deep=1` (Redis ping) for requests sending `x-health-secret: <value>` |
| `SUPPRESSION_FILE` | – | JSON array of suppression entries (see [Privacy](#privacy-and-personal-data)) |
| `MAX_BODY_BYTES` / `MAX_DOCUMENT_BYTES` | 65536 / 15 MB | HTTP request body cap / max filing document size |
| `USAGE_LOG` | – | `1` logs per-call usage JSON (tool, latency, ok, response size, hashed principal) to stderr |
| `CACHE_WRITE_BUDGET_BYTES` | `67108864` (64 MiB) | Fleet-wide bytes of Redis cache writes per UTC day (stored value + key + 96 B overhead each); then cache writes are skipped (0 commands) until midnight. `0` = no Redis cache writes. See [Redis memory budget](#redis-memory-budget). |
| `MEMORY_CACHE_MB` / `REDIS_MAX_VALUE_BYTES` / `HTTP_TIMEOUT_MS` | 128 / 262144 / 25000 | Tuning (`REDIS_MAX_VALUE_BYTES` is the stored, compressed size) |
| `HOST` / `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` / `TRUST_PROXY` | `127.0.0.1` / – / – / – | Self-hosted node server only |

## Hosted quotas and API keys

The hosted endpoint charges each tool call in **units** that approximate how many upstream requests it can trigger:

| Tool | Units |
|---|---|
| `list_supported_states` | 0 |
| `search_company`, `get_company_profile`, `get_xbrl_concept` | 1 |
| `list_filings` | 1 (6 with date filters or offset, which may page through up to 4 older-history files) |
| `get_financials` | 2 |
| `compare_companies` | 3 |
| `get_filing_document` | 4 by `url`, 10 by `company` + `accession` |
| `get_insider_trades` | 6 + `limit` (max 20 filings → 26) |
| `lookup_business_entity` | number of states (max 5) |

| Client | Per minute | Per day (UTC) |
|---|---|---|
| Anonymous (per IP, IPv6 per /64) | 30 (per instance) | 60 |
| All anonymous clients of one network (IPv4 /24, IPv6 /48) | – | 60 (10% of the global cap) |
| All anonymous clients together | – | 600 soft; then 10 per IP, up to 900 hard |
| Free API key | 120 (per instance) | 500 |

**Reserve, then refund.** The table above is the *estimate* reserved before a call. After the call the server charges the actual cost — the number of upstream requests it made, at least 1 — and refunds the rest. A call answered from cache costs 1 unit, so cheap cached calls cannot exhaust the shared anonymous budget. Refunds are kept locally and folded into the next counter update, so they cost no Redis commands.

Over-quota calls return a `RATE_LIMITED` tool error with `retry_after_seconds`, the scope (`minute`, `day`, `network`, `global`), the limit, and how to get a key. Running locally via `npx -y edgar-entity-mcp` has no quota.

Fair share of the upstream budget: `SEC_KEYED_RESERVED_RPS` (2 of the 6 SEC requests/s by default) is reserved for API-key callers, and each client may have at most `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` (4) upstream fetches in flight. The SEC token bucket refills smoothly (one token every ~167 ms at 6 rps, burst 2).

### API keys

Free keys: open an issue at [github.com/pgeneralpl/edgar-entity-mcp](https://github.com/pgeneralpl/edgar-entity-mcp/issues/new?title=Free+API+key+request). Keys look like `eem_<12-char id>_<24-hex HMAC>` and are **self-verifying**: the server checks the HMAC (keyed with `API_KEY_SECRET`) locally, so random or forged keys are rejected without touching Redis, and a client sending more than 10 bad keys in 10 minutes gets HTTP 429. A valid key is then looked up once (`eem:v1:apikey:<id>`, to honour deletion and per-key limits) and remembered for 5 minutes.

- Mint: `npx tsx scripts/create-key.ts [--per-day N] [--per-minute N]`. The key is printed once. The record holds **only** the creation date and optional limits: no owner name, email or other contact is collected (the key request lives in the issue tracker; note the key id there if you may need it later).
- Delete: `npx tsx scripts/delete-key.ts <key-or-id>` removes the record and all of the key's live counters; running instances stop accepting it within 5 minutes. For immediate revocation everywhere (also while Redis is unavailable), add the id to `REVOKED_KEY_IDS`. Rotating `API_KEY_SECRET` revokes every key at once.
- Both scripts need the deployment's `UPSTASH_REDIS_REST_*`, `IP_HASH_SALT` and `API_KEY_SECRET`.
- `include_agent_details` on `lookup_business_entity` only takes effect for API-key callers (see [Privacy](#privacy-and-personal-data)).

### Fitting the Upstash plan (and what happens when it runs out)

The hosted database is on Upstash's **Fixed 250 MB** plan. Its limits, as published on [upstash.com/pricing/redis](https://upstash.com/pricing/redis) and in the Upstash docs (checked 2026-10-29):

| Limit | Fixed 250 MB |
|---|---|
| Data size | 250 MB |
| Bandwidth | 50 GB / month |
| Commands | not counted or billed ("unlimited"); throughput limit 10,000 commands/s ("Max commands per second" for Fixed 250MB in the plan table on the pricing page) |
| Request / record size | 10 MB / 100 MB |
| Eviction | off on this database (see [Redis memory budget](#redis-memory-budget)) |
| At a limit | storage full: writes rejected; bandwidth used up: requests rejected. If the database has **auto-upgrade** enabled, Upstash upgrades it to the next tier instead (a cost, not an outage) |

Not stated by Upstash, so assumed conservatively here: that bandwidth counts **both directions** (requests and responses, including HTTP overhead), and that "MB" is 10^6 bytes (250 MB ≈ 238 MiB). Whether auto-upgrade is enabled is a database setting this code can't see.

Each `redis.call` inside a Lua script counts as a command for Upstash's per-command pricing (pay-as-you-go/free plans); on the Fixed plan only throughput and bandwidth matter. The counts below are those commands, measured with an exact emulator of the scripts in `tests/budget.test.ts` and `tests/cacheBudget.test.ts` (and the REST-visible part checked against real Upstash by `scripts/live-upstash.ts`):

| Event | Billed commands |
|---|---|
| Quota check, anonymous, allowed (`EVALSHA` + `INCRBY` on IP-day, /24-day, global-day) | 4 (+1 `EXPIRE` per counter the first time it is created that day: up to 7) |
| Quota check, API key, allowed (`EVALSHA` + `INCRBY`) | 2 (+1 the first call of the day) |
| Refused because a known counter has no room for this call's cost (own day, /24, global) | 0 |
| Refused inside the script (counter filled by another instance) | anonymous 7, key 3 (`INCRBY` + `DECRBY` rollback), then 0 |
| Refund of an unused estimate | 0 (folded into the next `INCRBY`) |
| Per-minute limit | 0 (in memory) |
| Random / forged API key, or key in `REVOKED_KEY_IDS` | 0 |
| MAC-valid key, first use (then memoised 5 min) | 1 (`GET`) |
| SEC / state-portal request, fleet token granted (`EVALSHA` + `HMGET` + `HSET` + `PEXPIRE`) | 4 per upstream request; keyed callers whose reserved bucket is empty: 2 + 4 |
| Shared cache: L1 (process memory) hit / Redis hit / miss | 0 / 1 / 1 (bytes read are charged to the call's quota, see below) |
| Shared cache write: one atomic `EVALSHA` (`GET` budget counter, `INCRBY`, `SET` value; + `SET NX EXAT` when it creates the counter) | 4 (5 when it creates the day's counter); + 1 `GET` of the counter on the first write of the day per instance |
| Cache write refused by the script (counter has no room) | 2 (`EVALSHA` + `GET`), then 0 for the rest of the UTC day |
| Suppression list refresh (`SMEMBERS`) | 1 per instance at cold start, then every 10 min while warm |
| Cache write skipped: write budget exhausted, "redis full", or value > `REDIS_MAX_VALUE_BYTES` | 0 |
| Any call in degraded mode | 0 |
| **Whole call**: warm `search_company` (process cache) | **4** |
| **Whole call**: cold call with 1 SEC request (quota 4, cache GET 1 + write 4, SEC token 4) | **13** (18 on the first call of the day) |

**Redis reads are charged.** A call's actual cost is max(upstream requests including retries, Redis cache bytes read ÷ 256 KiB rounded up, 1), capped at its estimate; the rest of the estimate is refunded. A call served from the shared cache therefore can't read many large values for one unit, and Redis read volume is bounded by the quotas (≤ 256 KiB stored per unit). Not covered: the ~240 KB ticker file read once per cold instance by calls whose estimate is too small to absorb it.

**Worst case with the defaults** (every value at the 256 KiB maximum, every quota fully used every day, retries at the 4-attempt maximum, a 31-day month). Assumed fleet behaviour: ≤ 500 cold instance starts a day and ≤ 20 instances warm at once; ≤ 30 cache reads per call (the largest call, `get_insider_trades` with 20 Form 4s, makes ~27); 1 KB of request/response/HTTP overhead per command; cache reads returned base64-encoded (×4/3).

| Source | Commands / day | Bandwidth / day |
|---|---|---|
| Anonymous quota checks: ≤ 900 allowed calls (global hard ceiling) × 7 | 6,300 | |
| Anonymous cache `GET`s: ≤ 900 calls × 30; bytes ≤ 900 units × 256 KiB × 4/3 | 27,000 | 315 MB |
| Anonymous upstream requests (incl. retries, each charged): ≤ 900 × (4 token + 4 cache write) | 7,200 | |
| Cache writes, fleet-wide: ≤ 64 MiB budget (+20 % JSON escaping on uncompressed values) | (in the row above) | 81 MB |
| Script refusals on cold instances: 7 per instance per exhausted counter (≤ 3), ≤ 500 starts | 10,500 | |
| `SMEMBERS` suppression refresh: 20 warm × 144 + 500 cold starts | 3,400 | < 1 MB (small set) |
| Budget counter `GET` (first write of the day per instance; the counter is created inside the write script) | 500 | |
| Ticker file read per cold instance (~240 KB × 4/3, not always charged) | 500 | 160 MB |
| Command overhead (1 KB × commands above) | | 56 MB |
| **Anonymous tier + fleet, per day** | **≈ 56K** | **≈ 612 MB** |
| **Per month (31 d)** | **≈ 1.7M** | **≈ 19.0 GB** |
| Each API key at its full 500 units/day: quota 3 + key `GET` 1 per call, 30 `GET`s per call, 10 per upstream request (4 + 2 when the keyed reserve is empty, + 4 write) | ≈ 24K / day, ≈ 0.7M / month | ≈ 198 MB / day, ≈ **6.1 GB / month** |

So with the defaults: the anonymous tier uses at most ~38 % of the 50 GB/month, each API key used to its full daily quota every day adds ~12 %, and ~5 such keys would reach the limit. Realistic traffic is far lower (most cached values are a few KB, not 256 KiB). Throughput is not a concern: even the whole worst-case day is ≈ 0.6 commands/s on average, far from 10,000/s. To keep a margin, size `QUOTA_KEY_PER_DAY` / per-key limits so that 19.0 GB + 6.1 GB × (fully active keys) × (per-key units ÷ 500) stays under ~40 GB. When a limit is reached anyway (and auto-upgrade is off), Redis rejects requests and the server degrades instead of failing:

**Degraded mode.** If Redis errors, times out or reports its plan limit (`max requests limit`), the instance switches for 60 s at a time to:
- local in-memory quotas (same daily limits, per instance);
- **anonymous callers: cache only** — anything not already in this instance's memory is refused with a clear `RATE_LIMITED` (`scope: "degraded"`) message;
- **API-key callers:** SEC at `DEGRADED_SEC_RPS` (0.2/s) per instance (`0` = refuse); MAC-valid keys are accepted without the Redis lookup but treated as unverified (no `include_agent_details`); keys in `REVOKED_KEY_IDS` are still refused;
- state-registry lookups refused if the suppression list was never loaded on that instance.

`/health` reports `status: "degraded"` with the reason (`redis unavailable`, `redis plan limit reached` (e.g. the monthly bandwidth), or `redis full` when the quota script itself hits the data-size limit).

### Redis memory budget

The Upstash database runs with **eviction off**. Upstash has a single eviction policy ("optimistic-volatile": random keys, TTL keys first, then any key), so with eviction on, a full database would silently drop quota counters (resetting them, i.e. failing open), API key records and the suppression set. With eviction off, a full database rejects writes (`ERR DB capacity quota exceeded`) instead, so the cache has to stay well below the plan's data size (250 MB on the Fixed 250 MB plan, taken as 250 × 10^6 bytes ≈ 238 MiB) by itself. With the defaults, worst-case stored data is ≈ 2 × 64 MiB + < 1 MB ≈ **135 MB, ~54 % of 250 MB**:

- **Daily write budget** (`CACHE_WRITE_BUDGET_BYTES`, default **64 MiB**, fleet-wide): every Redis cache write counts its stored size (value + key + 96 bytes of per-key overhead) on `eem:v1:cw:<YYYYMMDD>`, and the check and the write are **one atomic Lua script** (`EVALSHA`, `EVAL` fallback): if counter + size > budget the script returns −1 and writes nothing; otherwise it creates the counter if missing (`SET 0 NX EXAT <next midnight + 1 h>`, so the counter always has its ≤ 25 h TTL), `INCRBY`s it and `SET … EX`s the value. The counter therefore **never exceeds the budget**, whatever the number of instances or concurrent writes (tested: 10 fresh instances × 50 concurrent writes against a full counter → 0 writes; from an empty counter → exactly the budget, never more; also checked against real Upstash). Local memo, to avoid useless commands: an instance's first write of the day reads the counter once (one `GET`, shared by concurrent writes), so a cold instance facing a full counter refuses without sending any value; in-flight writes are reserved locally and replies raise the memo to max(known, fleet total + this instance's pending writes). Once the memo or the script says no, that instance skips Redis cache writes **with 0 commands** until the UTC day ends. Reads continue; the process-memory cache keeps working. `0` disables Redis cache writes.
- **TTLs end with the day**: every Redis TTL is min(normal TTL, 24 h, time until 01:00 UTC of the next day). Entries written on a UTC day are gone 1 h after it ends, so the resident cache is one day's budget, at most two (yesterday's entries plus today's writes, and only between 00:00 and 01:00 UTC): ≤ 2 × 64 MiB ≈ 134 MB. The normal TTLs are: tickers, filing documents, parsed Form 4s 24 h; XBRL frames 12 h; filing history / facts / concepts 6 h; state searches 1 h; submissions 10 min.
- **Max value** `REDIS_MAX_VALUE_BYTES` (default 256 KiB, measured after compression). Values ≥ 8 KB are stored gzip-compressed (level 6, base64, marked by a `\u0001gz1:` prefix; decompression capped at 32 MB); larger values stay in process memory only (values over 20 × the max are not even compressed). The SEC ticker file (`company_tickers_exchange.json`, ~520–585 KB) compresses to ~240 KB and is shared once a day (1 SEC request and one write per day fleet-wide instead of one SEC request per cold instance).
- **"redis full"**: if a cache write still gets a capacity error (`ERR DB capacity quota exceeded`, `OOM command not allowed`), that instance stops **only cache writes** for 10 minutes (`/health` → `redis_cache.writes: "redis full"`). Quota counters, the quota script, API keys and suppression are unaffected and keep their fail-closed / degraded handling. Plan request limits (`max requests limit`) and outages still trigger degraded mode as before.
- Non-cache data is tiny: daily counters (a few bytes each, 25 h TTL), token buckets, API key records and the suppression set.

`/health` shows `redis_cache: { writes: "on" | "redis full" | "disabled", write_budget_bytes_per_utc_day, max_value_bytes, … }` (no traffic volumes). Whether today's write budget is exhausted (a usage signal) is shown only with `?deep=1` and `x-health-secret: <HEALTH_SECRET>`, as `redis_write_budget: { state, until, known_used_bytes }`.

Other limits on the HTTP endpoint: 64 KB request bodies, no JSON-RPC batches (one message per request), at most 20 Form 4 filings per insider call and 5 states / 25 results per state per entity lookup, filing documents up to 15 MB.

## Privacy and personal data

- Registered agents and service-of-process contacts are treated as **individuals unless the name ends with a legal-form suffix** (Inc, Corp, LLC, LLP, LP, Ltd, Company, "& Co", Bank, N.A., …) or is a known registered-agent service (CT Corporation, CSC, Cogency Global, …). "JOHN CHURCH", "JUDE LAW", "DAVID CO" and "JOHN SMITH PA" are individuals; ambiguous CO/PA/PC endings count as individual.
- Individual agents are returned as `{ "kind": "individual", "withheld": true }`, and the entity's principal/mailing addresses (and NY location name) are withheld too (`addresses_withheld: true`), since for one-person businesses these are often a home address. `include_agent_details: true` reveals them **only for API-key callers** (and local stdio use); anonymous HTTP callers get a privacy note instead. Organizational agents are always shown.
- Erasure/objection requests: add `entity:<STATE>:<id>` or `agent:<name>` with `npx tsx scripts/suppress.ts add ...` (Redis set, picked up within 10 minutes), `SUPPRESSION_FILE`, or `src/states/suppression-list.ts`. Entity ids are normalized (case, punctuation, leading zeros). A suppressed name is matched as whole words in agent names and addresses **and** in the entity name, NY location name and principal/mailing addresses; any hit removes every personal field of that record, and a hit in the entity name (also matched with spaces removed, e.g. "JANEDOE HOLDINGS LLC") replaces the name with `[withheld]`. If Redis is configured but the suppression list cannot be loaded on a cold instance, state lookups are refused (before any registry request) rather than served without it.
- Form 4 reporting-owner names are statutory public disclosures and are returned by `get_insider_trades`.

### What the hosted server stores, and for how long

Rate limiting keeps **only integer counters** in Redis, under hashed identifiers, with a TTL equal to the window being enforced:

| Redis key | Value | TTL |
|---|---|---|
| `eem:v1:q:d:ip:<hash>:<YYYYMMDD>` | units used today (UTC) by one IP (IPv6: /64) | 25 h (the day + 1 h slack) |
| `eem:v1:q:d:net:<hash>:<YYYYMMDD>` | units used today by all anonymous clients of one /24 (IPv6: /48) | 25 h |
| `eem:v1:q:d:anon:<YYYYMMDD>` | units used today by all anonymous clients together | 25 h |
| `eem:v1:q:d:key:<id>:<YYYYMMDD>` | units used today by one API key | 25 h |
| `eem:v1:cw:<YYYYMMDD>` | bytes of cache writes today, whole fleet (no per-client data) | ≤ 25 h |

- `<hash>` for IPs is `HMAC-SHA256(daily salt, IP or prefix)` truncated to 80 bits, where the daily salt is `HMAC-SHA256(IP_HASH_SALT, YYYYMMDD)`. Hashes from different days can't be linked, and once a day's counters expire nothing derived from that day's IPs is left. A request is hashed and counted against the same UTC day, so requests that straddle midnight are counted consistently. The per-minute counter for an IP restarts at midnight because its hash changes, so a client can get at most one extra minute's worth of quota at that moment.
- For keys, `<id>` is the key's public id (the secret part never reaches Redis). API key records (`eem:v1:apikey:<id>`) hold only the creation date and optional per-key limits, until deleted with `scripts/delete-key.ts` (which also deletes the key's counters). The suppression set (`eem:v1:suppress`) holds erasure-request entries.
- Not stored anywhere in Redis: raw IPs, user agents, request paths, tool arguments, per-tool usage history. Shared cache entries for public SEC and state data are stored under `eem:v1:c:<sha256 of the upstream request>`, so key names don't reveal what was searched; they expire after at most 24 h. The upstream fan-out budget (`eem:rl:*`) is a global token bucket with no per-client data.
- **Logs**: errors (and, with `USAGE_LOG=1`, one line per call with tool name, latency, outcome, response size and the daily-rotating principal hash) go to stderr, then to Vercel runtime logs, which expire under Vercel's plan retention ([limits](https://vercel.com/docs/logs/runtime#limits)). Error text has URL query strings, IP addresses, email addresses and credential-like values masked. Tool arguments, API keys and raw IPs are never logged by this server. Vercel's own platform request logs (outside this code) record request metadata such as path and client IP under Vercel's retention.
- Per-minute limits are kept in process memory only (70 s) and never written to Redis.
- `/health` reports this configuration under `quotas.state`.

## Required configuration before resuming the hosted deployment

Set these in the Vercel project (Production and Preview) before taking the deployment out of pause. With Redis configured, the server refuses to serve (HTTP 503, `/health` → `misconfigured`) until `IP_HASH_SALT` and `API_KEY_SECRET` are valid.

| Variable | Value |
|---|---|
| `SEC_USER_AGENT` | `"<Operator name> <contact email>"` (SEC fair-access policy) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel's `KV_REST_API_URL` + `KV_REST_API_TOKEN`) | the Upstash database |
| `IP_HASH_SALT` | ≥ 32 random chars (`openssl rand -hex 32`) |
| `API_KEY_SECRET` | ≥ 32 random chars, different from `IP_HASH_SALT` |
| `HEALTH_SECRET` | random; enables `/health?deep=1` |
| `SOCRATA_APP_TOKEN` | free app token from the state portals (higher throttling limits) |
| `KEY_REQUEST_URL` | where users request a free key (default: GitHub issue link) |
| `DEGRADED_SEC_RPS` | `0.2` (or `0` to stop SEC calls entirely while Redis is out) |
| `MCP_REQUIRE_API_KEY` | optional: `1` to disable anonymous use |

Also recommended: Upstash usage alerts, and `REVOKED_KEY_IDS` kept empty unless needed. Mint keys only after `API_KEY_SECRET` is final (rotating it invalidates them).

## Security notes

- Filing text from `get_filing_document` is untrusted, filer-authored content. It is returned between `<<<BEGIN UNTRUSTED SEC FILING TEXT id=<nonce>>>>` / `<<<END UNTRUSTED SEC FILING TEXT id=<nonce>>>>` markers, where the nonce is random per response and repeated in `untrusted_marker_id`, so filer text cannot fake a closing marker. Zero-width, bidi control, Unicode tag characters (U+E0000–E007F) and variation selectors (U+FE00–FE0F, U+E0100–E01EF) are stripped. Other third-party text (entity names and addresses, Form 4 reporter names, remarks and footnotes, XBRL labels and descriptions) is cleaned the same way and listed in each response's `untrusted_fields`. Agents should treat all of it as data, never as instructions.
- Only `https://www.sec.gov/Archives/edgar/data/<CIK>/<accession>/<file>` URLs are accepted as document input; redirects are followed manually and re-checked against the host allowlist.
- Error messages returned to clients are generic; details go to server logs with a reference id.

## SEC User-Agent and rate limits

SEC's [fair-access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) caps clients at **10 requests/second** and requires a declared User-Agent. SEC may block clients without one (HTTP 403 "Undeclared Automated Tool"). This server:
- sends `SEC_USER_AGENT` on every SEC request;
- spaces requests through a two-stage limiter: per-process spacing plus, with Redis, atomic fleet-wide token buckets (6 req/s default, 2 of them reserved for API-key callers; smooth refill, burst 2). If no token is granted within ~5 s the call fails with `RATE_LIMITED`; if Redis itself is unavailable or over its plan, anonymous callers are served from cache only and API-key callers at 0.2 req/s per instance (degraded mode);
- retries 429/5xx with exponential backoff and respects `Retry-After`;
- deduplicates identical in-flight requests and caches with TTLs: tickers 24h, submissions 10 min, companyfacts/concepts 6h, frames 12h, filing documents 24h in process memory (raw documents are never written to Redis; processed text under 256 KB and parsed Form 4s are shared for 24h), state searches 1h. No Redis cache entry lives longer than 24h.

## Monetization hooks (no billing yet)

- **HTTP gate**: self-verifying keys registered in Redis (`scripts/create-key.ts` / `scripts/delete-key.ts`), `MCP_API_KEYS` static keys, or `createHttpHandler({ verifyKey: async (k) => principalOrNull })` for keys stored elsewhere. Invalid keys get 401.
- **Per-call metering**: `setUsageHooks({ beforeCall, afterCall })` (exported from the package). `beforeCall` receives `{tool, transport, apiKey, clientId, principal, args}`; throwing a `ToolError` rejects the call with that code (anything else becomes `UNAUTHORIZED`). The built-in quota hook runs first. `afterCall` receives `{ok, ms, errorCode, responseChars}`, which is enough for pay-per-call or per-token pricing.
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
