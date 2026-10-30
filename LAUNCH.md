# Launch kit: edgar-entity-mcp

Repo: https://github.com/pgeneralpl/edgar-entity-mcp · Live endpoint: `https://edgar-entity-mcp.vercel.app/mcp` (health: https://edgar-entity-mcp.vercel.app/health)

## Pre-launch checklist (owner)

1. ~~`gh repo create pgeneralpl/edgar-entity-mcp --public --source . --push`~~ (done)
2. ~~Set owner `pgeneralpl` in `package.json` (`mcpName`, `repository`, `homepage`, `bugs`), `server.json`, `manifest.json` and this file~~ (done)
3. ~~`npm publish --access public`~~ (v0.1.0 was published 2026-10-20). **The npm package is deprecated and no longer maintained; nothing further is published to npm.**
4. ~~Deploy: `vercel link && vercel env add SEC_USER_AGENT && vercel deploy --prod`~~ (done, live at `https://edgar-entity-mcp.vercel.app/mcp`; GitHub auto-deploy and the Upstash Redis store are connected). Production configuration: see [docs/OPERATIONS.md](docs/OPERATIONS.md#production-configuration).
5. Future releases: bump the version in `package.json`, run `npm run gen` (copies it into `server.json`), commit, then `gh release create vX.Y.Z` (or run the Release workflow manually). `.github/workflows/release.yml` publishes only to the MCP Registry (remote endpoint, no package) via GitHub OIDC.
6. ~~MCP Registry (first release)~~ (done: `io.github.pgeneralpl/edgar-entity-mcp` 0.1.0, active).
7. Submit the listings below. For Smithery, use URL publishing: smithery.ai/new → `https://edgar-entity-mcp.vercel.app/mcp`. A static server card is served at `/.well-known/mcp/server-card.json`. Smithery has moved to URL publishing for remote servers and MCPB bundles for local ones, so no `smithery.yaml` is included.

---

## Glama (glama.ai/mcp/servers)

**Name:** EDGAR + Entity: US Company Research
**Short description (≤100 chars):** SEC filings, XBRL financials, insider trades and state business-entity lookups for AI agents.
**Long description:**
edgar-entity-mcp gives agents one tool belt for researching US companies using only official, free, commercially usable public data.

- **SEC EDGAR**: resolve tickers and names to CIKs, pull company profiles, list filings by form and date, and read any 10-K/10-Q as clean text with item extraction (Risk Factors, MD&A, Financial Statements) and paging.
- **Financials**: normalized revenue, margins, EPS, cash flow, FCF and balance sheet from XBRL, annual or quarterly, deduped by fiscal period. Each metric reports the exact tag used.
- **Compare**: rank or compare any XBRL concept across all filers for a period (SEC frames).
- **Insider trades**: Form 4 parsed into plain English, with an open-market buys vs. sales summary.
- **Business entities**: Secretary of State registry search for NY, CO, OR, CT and PA. Returns status, type, formation date, jurisdiction, addresses and registered agent.

Responses are compact JSON with source URLs. The server respects SEC fair-access rules (User-Agent, a fleet-wide 6 req/s token bucket that fails closed, retries) and caches with Upstash or in memory. It runs remotely over Streamable HTTP (hosted endpoint) or locally over stdio from the GitHub source. MIT licensed.

**Tags:** finance, sec, edgar, xbrl, research, company-data, kyc, due-diligence

## Smithery

**Display name:** EDGAR + Entity: US Company Research
**Tagline:** Research any US company from SEC EDGAR and state registries, with sources included.
**Description:**
Ten read-only tools for analysts, founders and researchers: `search_company`, `get_company_profile`, `list_filings`, `get_filing_document` (10-K item extraction), `get_financials` (normalized XBRL), `get_xbrl_concept`, `compare_companies` (SEC frames), `get_insider_trades` (Form 4), `lookup_business_entity` (NY/CO/OR/CT/PA) and `list_supported_states`. There is also a `company_research_brief` prompt. No data API keys are needed.
**Config:** none needed for the hosted endpoint; set `SEC_USER_AGENT` when running locally.

## PulseMCP

**Title:** edgar-entity-mcp: SEC EDGAR + Secretary of State data
**One-liner:** Filings, financials, insider trades and business-entity lookups for US companies, built for agents.
**Description:**
A vertical MCP server for US company research. It combines SEC EDGAR (submissions, XBRL companyfacts/concept/frames, Form 4 XML, filing documents) with five state business-entity registries published as open data. Agent-friendly details: names or tickers are accepted wherever a CIK is needed, outputs are compact JSON with source URLs, long documents are paged, errors include hints, and the server documents which XBRL tag produced each number. Each state source was license-checked for commercial use; see DATA_SOURCES.md. Available as a remote Streamable HTTP endpoint; the source can also be run locally over stdio.
**Use cases:** equity research, competitive analysis, KYB / vendor due diligence, sales prospecting, journalism, academic research.

---

## X thread

1/ I built an MCP server for researching US companies, made for AI agents.

SEC EDGAR + state Secretary of State registries in one endpoint:
`https://edgar-entity-mcp.vercel.app/mcp`

The data is free, official and commercially usable. 🧵

2/ Ask your agent things like:
• "Compare TSLA, F and GM revenue for 2023"
• "What did Apple insiders sell this month?"
• "Summarize the risk factors in NVDA's latest 10-K"
• "Is Acme Widgets LLC active in Colorado, and who's the registered agent?"

3/ Under the hood:
• get_financials normalizes XBRL (revenue tag fallbacks, deduped periods, derived Q4) and reports which tag each number came from
• get_filing_document turns 10-Ks into clean text and pulls out Item 1A/7/8 directly
• get_insider_trades parses Form 4 XML into plain English

4/ State registries: NY, CO, OR, CT and PA through their open-data APIs. I checked each license for commercial use and documented the result (public domain or OPEN-NY terms). Delaware has no open data, sadly.

5/ It plays nice with SEC: declared User-Agent, a fleet-wide 6 req/s limiter, backoff on 429/503, per-client quotas, and caching (Upstash or in-memory). Responses are compact JSON with source URLs, so agents cite instead of hallucinating.

6/ Works in Claude Desktop, Cursor, Claude Code and VS Code via stdio, or remotely over Streamable HTTP: https://edgar-entity-mcp.vercel.app/mcp. MIT licensed.

Repo: github.com/pgeneralpl/edgar-entity-mcp
Feedback and state requests welcome 🙏

## Indie Hackers post

**Title:** I built a free, open-source MCP server for US company research

**Body:**
AI agents are good at reasoning about companies and bad at getting facts about them. Ask one for Apple's FY2025 free cash flow, or whether a Colorado LLC is in good standing, and you usually get a guess.

So I built **edgar-entity-mcp**, an MCP server that connects agents to official sources:

- **SEC EDGAR**: profiles, filings, 10-K/10-Q text with section extraction, normalized XBRL financials, cross-company comparisons and Form 4 insider trades
- **State business registries**: NY, CO, OR, CT and PA, via their open-data portals

**Why vertical?** Generic "fetch a URL" tools burn tokens and get XBRL wrong. Common mistakes are mixing up fiscal years from comparative columns and reading YTD cash flow as quarterly. Most of the value is in the normalization: tag fallbacks, deduping periods, deriving Q4, and turning Form 4 codes into English.

**Data licensing was step one.** I only enabled states whose open data permits commercial reuse. NY uses the OPEN-NY terms. CO, CT and PA are public domain, with CO requiring a disclaimer. Oregon is public domain by statute. All of it is documented in the repo.

**It's a free hobby project:** MIT-licensed source on GitHub and a keyless hosted endpoint with caching and low limits. There are no paid plans.

**Stack:** TypeScript, the official MCP SDK v2, zod, Vercel's `mcp-handler`, and Upstash Redis for a shared cache and a fleet-wide SEC rate budget.

I'd love feedback: which states or data would be most useful to you?

Repo: github.com/pgeneralpl/edgar-entity-mcp
