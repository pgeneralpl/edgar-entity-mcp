# Operations

Configuration for operators and self-hosters of edgar-entity-mcp: environment variables and their defaults, quotas, optional API keys, Redis, what the server stores, SEC rate limiting, deployment and library hooks. Users of the hosted endpoint only need the [README](../README.md).

- [Environment variables](#environment-variables)
- [Quotas](#hosted-quotas) ([API keys](#api-keys), [Degraded mode](#degraded-mode), [Usage statistics](#usage-statistics), [Redis memory budget](#redis-memory-budget))
- [What the hosted server stores](#what-the-hosted-server-stores-and-for-how-long)
- [SEC rate limiting and caching](#sec-rate-limiting-and-caching)
- [Production configuration](#production-configuration)
- [Library hooks](#library-hooks)

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SEC_USER_AGENT` | – (required) | **Set this** to your own `"<Name or Company> <email>"`, e.g. `"Acme Research jane@acme.com"`. SEC tools refuse to run (`CONFIG_ERROR`) while it is unset or a placeholder; state-registry tools still work. |
| `SEC_MAX_RPS` | `6` (max 8) | SEC requests per second: per process, and fleet-wide when Redis is configured |
| `SOCRATA_MAX_RPS` | `5` | State-portal requests per second (same two-stage limiter) |
| `DISTRIBUTED_RATE_LIMIT` | `1` | `0` disables the Redis token buckets (per-process limits only) |
| `SOCRATA_APP_TOKEN` | – | App token for the state portals (higher throttling limits; free at each portal's developer settings) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Enables Redis (Vercel's `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work). Without them cache and quotas are in-memory. |
| `QUOTA_ANON_PER_MINUTE` / `QUOTA_ANON_PER_DAY` | `30` / `60` | HTTP quota for anonymous clients, in units, per hashed IP |
| `QUOTA_ANON_NETWORK_PER_DAY` | 4× `QUOTA_ANON_PER_DAY`, at most 10% of the global cap (`min(240, 60)` = `60`) | Shared daily cap for all anonymous clients in one /24 (IPv6 /48), against address rotation; never more than 10% of `QUOTA_ANON_GLOBAL_PER_DAY` (with the defaults that ceiling is the lower value; the 4× default applies from a global cap of 2,400) |
| `QUOTA_ANON_GLOBAL_PER_DAY` / `QUOTA_ANON_GLOBAL_HARD_PER_DAY` / `QUOTA_ANON_TRICKLE_PER_DAY` | `600` / `900` / `10` | Soft daily cap for **all** anonymous clients together; past it each IP still gets the trickle allowance, up to the hard ceiling. API-key callers are not affected. |
| `QUOTA_KEY_PER_MINUTE` / `QUOTA_KEY_PER_DAY` | `120` / `500` | HTTP quota per API key (per-key overrides via `scripts/create-key.ts`) |
| `SEC_KEYED_RESERVED_RPS` | `2` | Part of `SEC_MAX_RPS` reserved for API-key callers (anonymous traffic shares the rest) |
| `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` | `4` | Concurrent upstream fetches per client (hashed IP or key); more wait, then get `RATE_LIMITED` |
| `DEGRADED_SEC_RPS` | `0.2` (max 2) | SEC rate for API-key callers while Redis is unavailable; `0` = refuse SEC calls. Anonymous callers are cache-only in that state. |
| `MCP_API_KEYS` | – | Comma-separated static keys (accepted alongside hashed keys stored in Redis) |
| `MCP_REQUIRE_API_KEY` | – | `1` rejects anonymous HTTP calls with 401 (0.1.x required a key whenever `MCP_API_KEYS` was set) |
| `KEY_REQUEST_URL` | GitHub issue link | Shown in `RATE_LIMITED` / 401 hints as the place to request a key |
| `IP_HASH_SALT` | – (**required with Redis**) | Secret (≥32 random chars, e.g. `openssl rand -hex 32`) for the IP hash. The salt actually used is `HMAC-SHA256(IP_HASH_SALT, UTC date)`, so it rotates daily. With Redis configured and this missing, set to the old default `edgar-entity-mcp`, or shorter than 32 chars, the server refuses to start (node: exit 1; Vercel: every request gets 503 and `/health` says `misconfigured`). |
| `API_KEY_SECRET` | – (**required with Redis**) | Secret (≥32 random chars, different from `IP_HASH_SALT`) used to sign API keys (`eem_<id>_<HMAC>`). Rotating it invalidates every minted key at once. Without Redis, minted keys are disabled. |
| `REVOKED_KEY_IDS` | – | Comma-separated key ids (or full keys) refused immediately on every instance, without Redis — use for urgent revocation, including during degraded mode |
| `HEALTH_SECRET` | – | Enables `/health?deep=1` (Node.js version and patch state, Redis ping, write-budget state) for requests sending `x-health-secret: <value>`; any other `?deep=1` request (or every one while unset) gets HTTP 401 |
| `STATS_ENABLED` | on | Aggregate daily usage counters in Redis (see [Usage statistics](#usage-statistics)). Written only by Vercel **production** (`VERCEL_ENV=production`) or a self-hosted server (no `VERCEL` env var); never by preview/development deployments. `0` / `false` / `off` / `no` turns them off (0 commands) |
| `STATS_SECRET` | – | Enables `GET /stats?days=N` for requests sending `x-stats-secret: <value>` (≥ 32 chars, e.g. `openssl rand -hex 32`); unset, shorter, wrong or missing → 404 (the endpoint is not revealed) |
| `SUPPRESSION_FILE` | – | JSON array of suppression entries (see [Privacy](../README.md#privacy-and-personal-data)) |
| `ALLOW_PERSON_AGENT_DETAILS` | off | Self-hosted HTTP only: `1` lets verified API-key callers use `include_agent_details` (natural-person registered agents and related addresses). Ignored on Vercel: the hosted endpoint never returns them. stdio is unaffected (always available locally). |
| `MAX_BODY_BYTES` / `MAX_DOCUMENT_BYTES` | 65536 / 15 MB | HTTP request body cap / max filing document size |
| `USAGE_LOG` | – | `1` logs per-call usage JSON (tool, latency, ok, response size, hashed principal) to stderr |
| `CACHE_WRITE_BUDGET_BYTES` | `67108864` (64 MiB) | Fleet-wide bytes of Redis cache writes per UTC day (stored value + key + 96 B overhead each); then cache writes are skipped (0 commands) until midnight. `0` = no Redis cache writes. See [Redis memory budget](#redis-memory-budget). |
| `MEMORY_CACHE_MB` / `REDIS_MAX_VALUE_BYTES` / `HTTP_TIMEOUT_MS` | 128 / 262144 / 25000 | Tuning (`REDIS_MAX_VALUE_BYTES` is the stored, compressed size) |
| `HOST` / `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` / `TRUST_PROXY` | `127.0.0.1` / – / – / – | Self-hosted node server only |

**Self-hosting:** set `KEY_REQUEST_URL` to your own contact or issue URL (absolute `https://` only), so the rate-limit and key hints your users see point to you rather than to the upstream project's higher-limits form.

## Hosted quotas

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
| Anonymous (per IP, IPv6 per /64) | 30 | up to 60 (shared networks may get less) |
| All anonymous clients of one network (IPv4 /24, IPv6 /48) | – | `QUOTA_ANON_NETWORK_PER_DAY` |
| All anonymous clients together | – | `QUOTA_ANON_GLOBAL_PER_DAY` soft, then a small trickle per IP, up to `QUOTA_ANON_GLOBAL_HARD_PER_DAY` |
| API key (defaults; per-key overrides) | 120 | 500 |

**Reserve, then refund.** The table above is the *estimate* reserved before a call. After the call the server charges the actual cost — the number of upstream requests it made (and shared-cache bytes read), at least 1 — and refunds the rest. A call answered from cache usually costs 1 unit, so cheap cached calls cannot exhaust the shared anonymous budget.

Over-quota calls return a `RATE_LIMITED` tool error with `retry_after_seconds`, the scope (`minute`, `day`, `network`, `global`), the limit, and a link to `KEY_REQUEST_URL`. Running locally via `npx -y edgar-entity-mcp` has no quota.

Fair share of the upstream budget: `SEC_KEYED_RESERVED_RPS` (2 of the 6 SEC requests/s by default) is reserved for API-key callers, and each client may have at most `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` (4) upstream fetches in flight.

### API keys

API keys are optional; the hosted endpoint works without one. Keys are minted by the operator. They look like `eem_<12-char id>_<24-hex HMAC>` and are **self-verifying**: the server checks the HMAC (keyed with `API_KEY_SECRET`) locally, so random or forged keys are rejected without touching Redis, and clients sending many bad keys are throttled. A valid key is then looked up once (`eem:v1:apikey:<id>`, to honour deletion and per-key limits) and remembered for 5 minutes.

- Mint: `npx tsx scripts/create-key.ts [--per-day N] [--per-minute N]`. The key is printed once. The record holds **only** the creation date and optional limits: no owner name, email or other contact is collected (the key request lives in the issue tracker; note the key id there if you may need it later).
- Delete: `npx tsx scripts/delete-key.ts <key-or-id>` removes the record and all of the key's live counters; running instances stop accepting it within 5 minutes. For immediate revocation everywhere (also while Redis is unavailable), add the id to `REVOKED_KEY_IDS`. Rotating `API_KEY_SECRET` revokes every key at once.
- Both scripts need the deployment's `UPSTASH_REDIS_REST_*`, `IP_HASH_SALT` and `API_KEY_SECRET`.
- `include_agent_details` on `lookup_business_entity` is never honoured on the hosted endpoint (Vercel). On a self-hosted HTTP server it works only for verified API-key callers and only when `ALLOW_PERSON_AGENT_DETAILS=1` (see [Privacy](../README.md#privacy-and-personal-data)).
- Clients send a key as `Authorization: Bearer <key>` or `x-api-key: <key>` (with mcp-remote: `--header "Authorization: Bearer <key>"`).

### Degraded mode

If the backing store (Redis) is unavailable, the server degrades instead of failing: it falls back to local quotas, anonymous callers are served from cache only (`RATE_LIMITED`, `scope: "degraded"`, for anything else), API-key callers get SEC data at `DEGRADED_SEC_RPS` (`0` = refuse) and keys in `REVOKED_KEY_IDS` are still refused. State-registry lookups are refused when the suppression list could not be loaded. `/health` reports `status: "degraded"`.

Size your Redis plan for your own quotas: request volume is bounded by the daily quotas and stored data by the [Redis memory budget](#redis-memory-budget). Enable your provider's usage alerts.

### Usage statistics

With Redis configured and `STATS_ENABLED` not `0`, the HTTP server keeps **aggregate** counters per UTC day (`src/core/stats.ts`). Every write sets `EXPIREAT` = end of that UTC day + **30 days**, so each key always has a TTL (no relative TTL that a later write could extend) and disappears 30 days after its day.

**Where it runs.** Stats are recorded only when `VERCEL_ENV === "production"`, or when the server is not on Vercel at all (no `VERCEL` env var, i.e. self-hosted). Preview and development deployments on Vercel never write stats (and no longer have Redis at all; see the note in [Production configuration](#production-configuration)). **Self-hosted HTTP servers with Upstash configured have stats on by default**; set `STATS_ENABLED=false` to turn them off. stdio (`npx`) never records anything.

| Key | Type | Content |
|---|---|---|
| `eem:v1:stats:YYYY-MM-DD:c` | hash | `calls:<tool>`, `ok:<tool>`, `err:<tool>`; `ec:<ERROR_CODE>` (known codes, else `OTHER`); `tier:anon` / `tier:key`; `init` (MCP `initialize` = sessions); `degraded` (degraded-mode activations); `lat:<ms>` latency histogram (≤ 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000 ms, `inf`); `flush_fail` |
| `eem:v1:stats:YYYY-MM-DD:u` | HyperLogLog | approximate unique clients: `HMAC-SHA256(random daily salt, principal id)`, 64 bits. The principal id is already the daily-salted IP hash or the key id; the raw IP and the key id never reach this key |
| `eem:v1:stats:YYYY-MM-DD:cl` | sorted set | client-software **label from a fixed allowlist** (`claude`, `claude-code`, `cursor`, `vscode`, `mcp-inspector`, `windsurf`, `zed`, `continue`, `cline`, `roo-code`, `goose`, `openai`, `gemini`, `librechat`, `n8n`, `mcp-remote`, `jetbrains`, `amazon-q`, `lm-studio`, `cherry-studio`, `5ire`, `warp`, `postman`, `opencode`, `fast-agent`, `mcp-use`, `smithery`), optionally with the major version (`cursor/1`); every other `clientInfo.name` is recorded as `other`, so no client-supplied text is stored. Counted **once per principal per day** (deduplicated in each instance's memory) and only **after that principal's first successful tool call**, not on `initialize`, so a client cannot inflate counts by reconnecting. The score is the number of principals |
| `eem:v1:stats:salt:YYYY-MM-DD` | string | the random daily salt for the HLL. Its TTL is end(D) + 1 h − now, so it is gone at 01:00 UTC the next day, whenever it was created; once that time has passed no HLL member is written for D (pending members are dropped) and each flush forgets in-memory salts of earlier days. Until then the HLL is pseudonymous (salt + a principal id would allow a membership test); afterwards nobody (not even with `IP_HASH_SALT`) can test whether a given client is in that day's HLL |

Bounded: about 4 keys per day (3 + salt), ≤ 3 × 31 + 2 ≈ 95 keys in total; ≤ ~70 hash fields per day (tool names are the registered tools, other strings map to `other` / `OTHER`); ≤ 28 client labels per day (allowlist + `other`); ≤ ~20 KB per day (HLL ≤ 12 KB dense), **≤ ~1 MB for 30 days**.

**Cost.** Events are aggregated in each instance's memory and written with one `EVALSHA` per flush, at most once a minute per instance, fire-and-forget: writes never fail or delay a request, never trip degraded mode, and are skipped while Redis is degraded.

`GET /stats?days=N` (1–30, default 7) with `x-stats-secret: <STATS_SECRET>` returns `days[]` (today first) and `totals`: calls / ok / errors per tool, error codes, tiers, sessions, `unique_clients_approx` (HLL `PFCOUNT`, per day; `totals.unique_client_days_approx` sums them, so a client seen on 3 days counts 3), client labels (`principals` per day; `principal_days` in the totals), degraded activations and the latency histogram with approximate `p50` / `p95` (upper edge of the bucket, e.g. `"<=250"`). One `EVALSHA` per request (3 inner reads per day). Only counts are returned; HLL members are never read. Constant-time secret comparison; an unset, wrong or missing secret all return the same 404, so the endpoint's existence is not revealed.

### Redis memory budget

Run Redis with **eviction off**, so that a full database rejects writes instead of silently dropping quota counters (failing open), API key records or the suppression set. The cache then has to bound itself:

- **Daily write budget** (`CACHE_WRITE_BUDGET_BYTES`, default **64 MiB**, fleet-wide): every Redis cache write counts its stored size on a per-UTC-day counter, and the check and the write are one atomic Lua script, so the counter never exceeds the budget. Once it is spent, cache writes are skipped until the UTC day ends; reads continue and the process-memory cache keeps working. `0` disables Redis cache writes.
- **TTLs end with the day**: no Redis cache entry outlives the next day's 01:00 UTC, so resident cache data stays within about 2 × `CACHE_WRITE_BUDGET_BYTES` plus a few MB of counters, key records and statistics. Normal TTLs: tickers, filing documents, parsed Form 4s 24 h; XBRL frames 12 h; filing history / facts / concepts 6 h; state searches 1 h; submissions 10 min.
- **Max value** `REDIS_MAX_VALUE_BYTES` (default 256 KiB, measured after compression). Larger values are gzip-compressed; values that still don't fit stay in process memory only.
- **"redis full"**: if a cache write gets a capacity error, that instance pauses only cache writes for a while (`/health` → `redis_cache.writes: "redis full"`); quota counters, API keys and suppression keep their fail-closed / degraded handling.

`/health` shows `redis_cache: { writes, write_budget_bytes_per_utc_day, max_value_bytes, … }`. Write-budget state, `node_version` and `node_runtime_patched` are shown only with `?deep=1` and `x-health-secret: <HEALTH_SECRET>`; `?deep=1` without a valid secret returns HTTP 401 and no health data.

## What the hosted server stores, and for how long

Rate limiting keeps **only integer counters** in Redis, under hashed identifiers, with a TTL equal to the window being enforced:

| Redis key | Value | TTL |
|---|---|---|
| `eem:v1:q:d:ip:<hash>:<YYYYMMDD>` | units used today (UTC) by one IP (IPv6: /64) | 25 h (the day + 1 h slack) |
| `eem:v1:q:d:net:<hash>:<YYYYMMDD>` | units used today by all anonymous clients of one /24 (IPv6: /48) | 25 h |
| `eem:v1:q:d:anon:<YYYYMMDD>` | units used today by all anonymous clients together | 25 h |
| `eem:v1:q:d:key:<id>:<YYYYMMDD>` | units used today by one API key | 25 h |
| `eem:v1:cw:<YYYYMMDD>` | bytes of cache writes today, whole fleet (no per-client data) | ≤ 25 h |

- `<hash>` for IPs is `HMAC-SHA256(daily salt, IP or prefix)` truncated to 80 bits, where the daily salt is `HMAC-SHA256(IP_HASH_SALT, YYYYMMDD)`. Hashes from different days can't be linked, and once a day's counters expire nothing derived from that day's IPs is left. A request is hashed and counted against the same UTC day, so requests that straddle midnight are counted consistently.
- For keys, `<id>` is the key's public id (the secret part never reaches Redis). API key records (`eem:v1:apikey:<id>`) hold only the creation date and optional per-key limits, until deleted with `scripts/delete-key.ts` (which also deletes the key's counters). The suppression set (`eem:v1:suppress`) holds erasure-request entries.
- Aggregate usage statistics (`eem:v1:stats:*`, 30 days after the end of each UTC day, production / self-hosted only, see [Usage statistics](#usage-statistics)): per-day counts per tool / outcome / error code / tier / latency bucket, session count, allowlisted client-software labels (unknown names → `other`), and an approximate unique-client count (HyperLogLog over a hash keyed with a random daily salt that is deleted at 01:00 UTC the next day; pseudonymous until then). No per-client records.
- Not stored anywhere in Redis: raw IPs, user agents, request paths, tool arguments, per-client usage history. Shared cache entries for public SEC and state data are stored under `eem:v1:c:<sha256 of the upstream request>`, so key names don't reveal what was searched; they expire after at most 24 h. The upstream fan-out budget (`eem:rl:*`) is a global token bucket with no per-client data.
- **Logs**: errors (and, with `USAGE_LOG=1`, one line per call with tool name, latency, outcome, response size and the daily-rotating principal hash) go to stderr, then to Vercel runtime logs, which expire under Vercel's plan retention ([limits](https://vercel.com/docs/logs/runtime#limits)). Error text has URL query strings, IP addresses, email addresses and credential-like values masked. Tool arguments, API keys and raw IPs are never logged by this server. Vercel's own platform request logs (outside this code) record request metadata such as path and client IP under Vercel's retention.
- Per-minute limits are never written to Redis.
- `/health` reports this configuration under `quotas.state`.

## SEC rate limiting and caching

SEC's [fair-access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) caps clients at **10 requests/second** and requires a declared User-Agent. SEC may block clients without one (HTTP 403 "Undeclared Automated Tool"). This server:
- sends `SEC_USER_AGENT` on every SEC request;
- spaces requests through a two-stage limiter: per-process spacing plus, with Redis, atomic fleet-wide token buckets (6 req/s default, 2 of them reserved for API-key callers). A call that gets no token in time fails with `RATE_LIMITED`; while Redis is unavailable the server runs in [degraded mode](#degraded-mode);
- retries 429/5xx with exponential backoff and respects `Retry-After`;
- deduplicates identical in-flight requests and caches with TTLs: tickers 24h, submissions 10 min, companyfacts/concepts 6h, frames 12h, filing documents 24h in process memory (raw documents are never written to Redis; processed text under 256 KB and parsed Form 4s are shared for 24h), state searches 1h. No Redis cache entry lives longer than 24h.

## Production configuration

These are the variables a Vercel deployment needs in its **Production** environment; check them before any redeploy or migration. With Redis configured, the server refuses to serve (HTTP 503, `/health` → `misconfigured`) until `IP_HASH_SALT` and `API_KEY_SECRET` are valid. Give Preview deployments their own secrets (e.g. a separate `HEALTH_SECRET`) rather than reusing Production's.

> **Keep Redis Production-only.** Scope the Upstash integration variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN`) to **Production only**, so Preview and Development deployments run without Redis (in-memory cache and per-instance limits) and never read or write production data. Re-connecting or re-configuring the integration can re-add the Preview/Development scopes, so re-check `vercel env ls` after any integration change.

| Variable | Value |
|---|---|
| `SEC_USER_AGENT` | `"<Operator name> <contact email>"` (SEC fair-access policy) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel's `KV_REST_API_URL` + `KV_REST_API_TOKEN`) | the Upstash database |
| `IP_HASH_SALT` | ≥ 32 random chars (`openssl rand -hex 32`) |
| `API_KEY_SECRET` | ≥ 32 random chars, different from `IP_HASH_SALT` |
| `HEALTH_SECRET` | random; enables `/health?deep=1` (401 without it) |
| `STATS_SECRET` | optional, ≥ 32 random chars; enables `GET /stats` (404 while unset or on a wrong secret) |
| `SOCRATA_APP_TOKEN` | free app token from the state portals (higher throttling limits) |
| `KEY_REQUEST_URL` | where users request a key (default: GitHub issue link) |
| `DEGRADED_SEC_RPS` | `0.2` (or `0` to stop SEC calls entirely while Redis is out) |
| `MCP_REQUIRE_API_KEY` | optional: `1` to disable anonymous use |

Also recommended: usage alerts at your Redis provider, and `REVOKED_KEY_IDS` kept empty unless needed. Mint keys only after `API_KEY_SECRET` is final (rotating it invalidates them).

## Library hooks

- **HTTP gate**: self-verifying keys registered in Redis (`scripts/create-key.ts` / `scripts/delete-key.ts`), `MCP_API_KEYS` static keys, or `createHttpHandler({ verifyKey: async (k) => principalOrNull })` for keys stored elsewhere. Invalid keys get 401.
- **Per-call usage hooks**: `setUsageHooks({ beforeCall, afterCall })` (exported from the package). `beforeCall` receives `{tool, transport, apiKey, clientId, principal, args}`; throwing a `ToolError` rejects the call with that code (anything else becomes `UNAUTHORIZED`). The built-in quota hook runs first. `afterCall` receives `{ok, ms, errorCode, responseChars}`, for custom metering or logging.
