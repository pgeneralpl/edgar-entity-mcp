# Changelog

## 0.2.0 (unreleased)

Security hardening (audit 2026-10-20).

- **Quotas (C1):** cost-weighted per-IP and per-API-key limits on the HTTP endpoint (anonymous 30 units/min and 300/day per IP plus 3,000/day per /24 network against IP rotation; free key 120/min, 5,000/day), with `RATE_LIMITED` errors carrying `retry_after_seconds` and a key-request hint. Hashed API keys in Redis (`scripts/create-key.ts`). JSON-RPC batches rejected; insider fan-out capped at 20 filings, entity lookups at 5 states.
- **SEC limiter (C2):** two-stage limiter (local spacing + atomic Upstash token bucket, default 6 rps, max 8) that fails closed; also applied to state portals. Raw documents are no longer stored in Redis; cache keys are normalized.
- **SSRF / size (H1, L2):** strict EDGAR Archives URL validation, 15 MB streaming cap, manual redirects with host re-check.
- **Privacy (H3):** individual registered agents withheld unless `include_agent_details: true`; suppression list (`scripts/suppress.ts`); NY service-of-process field.
- **Prompt injection (H4):** filing text wrapped in untrusted-content markers with `untrusted_content: true`; zero-width/bidi characters stripped.
- **M1–M5, L1–L5:** `SOCRATA_APP_TOKEN` support and less overfetch; `findFiling` capped at 8 pages, failed ticker resolves not cached in Redis; `/health?deep=1` gated by `HEALTH_SECRET`; node server binds 127.0.0.1 with Host/Origin checks; 64 KB body cap; generic client errors with log reference ids; SEC tools refuse to run without a real `SEC_USER_AGENT`.
- **Data minimisation of rate-limit state:** Redis holds only integer counters with TTL = window (per-minute 60 s; daily per-IP, per-/24 and per-key 25 h); per-tool usage hashes and the 35-day key retention are removed. IP hashes use a daily-rotating salt `HMAC(IP_HASH_SALT, UTC date)`. Cache keys are hashed, so Redis key names never contain URLs or tool arguments. Error logs mask query strings, IPs and emails. The quota backend fails closed after 3 s. `create-key.ts` takes a reference `--label` and refuses names or emails.
- **Breaking:** setting `MCP_API_KEYS` no longer makes keys mandatory; use `MCP_REQUIRE_API_KEY=1`. `SEC_USER_AGENT` is now required for SEC tools. Default `SEC_MAX_RPS` 8 → 6.

## 0.1.0

- 10 tools: search_company, get_company_profile, list_filings, get_filing_document, get_financials, get_xbrl_concept, compare_companies, get_insider_trades, lookup_business_entity, list_supported_states
- `company_research_brief` prompt and `edgar-entity://data-sources` resource
- stdio CLI (`npx edgar-entity-mcp`) and Streamable HTTP (mcp-handler, Vercel function, local node server)
- Cache: in-memory LRU, or Upstash Redis with an L1 in front; SEC limiter (~8 req/s, optional fleet-wide); retries on 429/5xx
- API-key gate and usage hooks for future monetization
