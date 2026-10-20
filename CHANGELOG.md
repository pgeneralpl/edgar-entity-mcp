# Changelog

## 0.1.0 (unreleased)

- 10 tools: search_company, get_company_profile, list_filings, get_filing_document, get_financials, get_xbrl_concept, compare_companies, get_insider_trades, lookup_business_entity, list_supported_states
- `company_research_brief` prompt and `edgar-entity://data-sources` resource
- stdio CLI (`npx edgar-entity-mcp`) and Streamable HTTP (mcp-handler, Vercel function, local node server)
- Cache: in-memory LRU, or Upstash Redis with an L1 in front; SEC limiter (~8 req/s, optional fleet-wide); retries on 429/5xx
- API-key gate and usage hooks for future monetization
