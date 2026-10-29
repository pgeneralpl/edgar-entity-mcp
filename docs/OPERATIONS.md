# Operations

Internals for operators and self-hosters of edgar-entity-mcp: environment variables, hosted quotas, optional API keys, the Upstash and Redis budgets, what the server stores, SEC rate limiting, production configuration and library hooks. Users of the hosted endpoint only need the [README](../README.md).

- [Environment variables](#environment-variables)
- [Hosted quotas](#hosted-quotas) ([API keys](#api-keys), [Fitting the Upstash plan](#fitting-the-upstash-plan-and-what-happens-when-it-runs-out), [Usage statistics](#usage-statistics), [Redis memory budget](#redis-memory-budget))
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
| `QUOTA_ANON_PER_MINUTE` / `QUOTA_ANON_PER_DAY` | `30` / `60` | HTTP quota for anonymous clients, in units, per hashed IP (per-minute limits are enforced per instance, in memory) |
| `QUOTA_ANON_NETWORK_PER_DAY` | 4× `QUOTA_ANON_PER_DAY`, at most 10% of the global cap (`min(240, 60)` = `60`) | Shared daily cap for all anonymous clients in one /24 (IPv6 /48), against address rotation; never more than 10% of `QUOTA_ANON_GLOBAL_PER_DAY` (with the defaults that ceiling is the lower value; the 4× default applies from a global cap of 2,400) |
| `QUOTA_ANON_GLOBAL_PER_DAY` / `QUOTA_ANON_GLOBAL_HARD_PER_DAY` / `QUOTA_ANON_TRICKLE_PER_DAY` | `600` / `900` / `10` | Soft daily cap for **all** anonymous clients together; past it each IP still gets the trickle allowance, up to the hard ceiling. API-key callers are not affected. |
| `QUOTA_KEY_PER_MINUTE` / `QUOTA_KEY_PER_DAY` | `120` / `500` | HTTP quota per API key (per-key overrides via `scripts/create-key.ts`) |
| `SEC_KEYED_RESERVED_RPS` | `2` | Part of `SEC_MAX_RPS` reserved for API-key callers (anonymous traffic shares the rest) |
| `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` | `4` | Concurrent upstream fetches per client (hashed IP or key); more wait, then get `RATE_LIMITED` |
| `DEGRADED_SEC_RPS` | `0.2` (max 2) | Per-instance SEC rate for API-key callers while Redis is unavailable or over its plan limit; `0` = refuse SEC calls. Anonymous callers are cache-only in that state. |
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
| `MAX_BODY_BYTES` / `MAX_DOCUMENT_BYTES` | 65536 / 15 MB | HTTP request body cap / max filing document size |
| `USAGE_LOG` | – | `1` logs per-call usage JSON (tool, latency, ok, response size, hashed principal) to stderr |
| `CACHE_WRITE_BUDGET_BYTES` | `67108864` (64 MiB) | Fleet-wide bytes of Redis cache writes per UTC day (stored value + key + 96 B overhead each); then cache writes are skipped (0 commands) until midnight. `0` = no Redis cache writes. See [Redis memory budget](#redis-memory-budget). |
| `MEMORY_CACHE_MB` / `REDIS_MAX_VALUE_BYTES` / `HTTP_TIMEOUT_MS` | 128 / 262144 / 25000 | Tuning (`REDIS_MAX_VALUE_BYTES` is the stored, compressed size) |
| `HOST` / `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` / `TRUST_PROXY` | `127.0.0.1` / – / – / – | Self-hosted node server only |

## Hosted quotas

The hosted endpoint charges each tool call in **units** that approximate how many upstream requests it can trigger:

| Tool | Units |
|---|---|
| `list_supported_states` | 0 |
| `search_company`, `get_company_profile` | 1 |
| `get_xbrl_concept` | 3 reserved, 1 charged when the tag is found directly (the reserve covers the `companyfacts` fallback for mis-cased or unknown tags) |
| `list_filings` | 1 (6 with date filters or offset, which may page through up to 4 older-history files) |
| `get_financials` | 2 |
| `compare_companies` | 1 per frame requested + 1 for resolving companies: 2 with `tag`; tags tried + 1 with `metric` (max 3 tags → 4; e.g. `revenue` / `net_income` 4 reserved, `gross_profit` 2), unused reservation refunded |
| `get_filing_document` | 4 by `url`, 10 by `company` + `accession` |
| `get_insider_trades` | 6 + `limit` (max 20 filings → 26) |
| `lookup_business_entity` | number of states (max 5) |

| Client | Per minute | Per day (UTC) |
|---|---|---|
| Anonymous (per IP, IPv6 per /64) | 30 (per instance) | 60 |
| All anonymous clients of one network (IPv4 /24, IPv6 /48) | – | 60 (4× the per-IP cap = 240, capped at 10% of the global cap) |
| All anonymous clients together | – | 600 soft; then 10 per IP, up to 900 hard |
| API key (defaults; per-key overrides) | 120 (per instance) | 500 |

**Reserve, then refund.** The table above is the *estimate* reserved before a call. After the call the server charges the actual cost — the number of upstream requests it made, at least 1 — and refunds the rest. A call answered from cache costs 1 unit, so cheap cached calls cannot exhaust the shared anonymous budget. Refunds are kept locally and folded into the next counter update, so they cost no Redis commands.

Over-quota calls return a `RATE_LIMITED` tool error with `retry_after_seconds`, the scope (`minute`, `day`, `network`, `global`), the limit, and a link to `KEY_REQUEST_URL`. Running locally via `npx -y edgar-entity-mcp` has no quota.

Fair share of the upstream budget: `SEC_KEYED_RESERVED_RPS` (2 of the 6 SEC requests/s by default) is reserved for API-key callers, and each client may have at most `MAX_CONCURRENT_UPSTREAM_PER_CLIENT` (4) upstream fetches in flight. The SEC token bucket refills smoothly (one token every ~167 ms at 6 rps, burst 2).

### API keys

API keys are optional; the hosted endpoint works without one. Keys are minted by the operator, for example for users who ask for higher limits in a GitHub issue. They look like `eem_<12-char id>_<24-hex HMAC>` and are **self-verifying**: the server checks the HMAC (keyed with `API_KEY_SECRET`) locally, so random or forged keys are rejected without touching Redis, and a client sending more than 10 bad keys in 10 minutes gets HTTP 429. A valid key is then looked up once (`eem:v1:apikey:<id>`, to honour deletion and per-key limits) and remembered for 5 minutes.

- Mint: `npx tsx scripts/create-key.ts [--per-day N] [--per-minute N]`. The key is printed once. The record holds **only** the creation date and optional limits: no owner name, email or other contact is collected (the key request lives in the issue tracker; note the key id there if you may need it later).
- Delete: `npx tsx scripts/delete-key.ts <key-or-id>` removes the record and all of the key's live counters; running instances stop accepting it within 5 minutes. For immediate revocation everywhere (also while Redis is unavailable), add the id to `REVOKED_KEY_IDS`. Rotating `API_KEY_SECRET` revokes every key at once.
- Both scripts need the deployment's `UPSTASH_REDIS_REST_*`, `IP_HASH_SALT` and `API_KEY_SECRET`.
- `include_agent_details` on `lookup_business_entity` only takes effect for API-key callers (see [Privacy](../README.md#privacy-and-personal-data)).
- Clients send a key as `Authorization: Bearer <key>` or `x-api-key: <key>` (with mcp-remote: `--header "Authorization: Bearer <key>"`).

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
| Usage statistics flush (production only; [details](#usage-statistics)) | 1 `EVALSHA` per ≤ 1 flush / min / instance (≈ 8–40 inner commands), + 1 salt `EVALSHA` per instance per UTC day |
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
| Usage statistics, worst case (separate from the totals above; [details](#usage-statistics)) | ≤ 29.3K `EVALSHA` (≤ ~1.2M inner ops) | ≤ ~180 MB / day, ≈ **5.5 GB / month (~11 % of 50 GB)** |
| Each API key at its full 500 units/day: quota 3 + key `GET` 1 per call, 30 `GET`s per call, 10 per upstream request (4 + 2 when the keyed reserve is empty, + 4 write) | ≈ 24K / day, ≈ 0.7M / month | ≈ 198 MB / day, ≈ **6.1 GB / month** |

So with the defaults: the anonymous tier uses at most ~38 % of the 50 GB/month, each API key used to its full daily quota every day adds ~12 %, and ~5 such keys would reach the limit. Realistic traffic is far lower (most cached values are a few KB, not 256 KiB). Throughput is not a concern: even the whole worst-case day is ≈ 0.6 commands/s on average, far from 10,000/s. To keep a margin, size `QUOTA_KEY_PER_DAY` / per-key limits so that 19.0 GB + 6.1 GB × (fully active keys) × (per-key units ÷ 500) stays under ~40 GB. When a limit is reached anyway (and auto-upgrade is off), Redis rejects requests and the server degrades instead of failing:

**Degraded mode.** If Redis errors, times out or reports its plan limit (`max requests limit`), the instance switches for 60 s at a time to:
- local in-memory quotas (same daily limits, per instance);
- **anonymous callers: cache only** — anything not already in this instance's memory is refused with a clear `RATE_LIMITED` (`scope: "degraded"`) message;
- **API-key callers:** SEC at `DEGRADED_SEC_RPS` (0.2/s) per instance (`0` = refuse); MAC-valid keys are accepted without the Redis lookup but treated as unverified (no `include_agent_details`); keys in `REVOKED_KEY_IDS` are still refused;
- state-registry lookups refused if the suppression list was never loaded on that instance.

`/health` reports `status: "degraded"` with the reason (`redis unavailable`, `redis plan limit reached` (e.g. the monthly bandwidth), or `redis full` when the quota script itself hits the data-size limit).

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

**Cost.** Events are aggregated in each instance's memory and written with **one** `EVALSHA` per flush (`HINCRBY` per field + `EXPIREAT`, `PFADD` + `EXPIREAT`, `ZINCRBY` per label + `ZCARD` (+ `ZREMRANGEBYRANK`) + `EXPIREAT`), plus one salt lookup (`EVALSHA` with `GET`, + `SET` once per day fleet-wide) per instance per UTC day. An instance flushes at most once per 60 s: the first event after a quiet minute is written immediately, later ones are coalesced into one trailing flush. Writes are fire-and-forget (registered with Vercel's `waitUntil`), time out after 1.5 s, never fail or delay a request, never trip degraded mode (a failed batch is dropped, counted in `flush_fail`, and stats back off 60 s, 10 min on "redis full"), and are skipped (0 commands) while Redis is degraded. Per flush the request carries ≤ 100 HLL members (16 hex chars), ≤ 20 labels and ≤ ~70 fields: **≤ ~6 KB including HTTP overhead, typically ~1–2 KB**.

| Scenario | Flushes / day | Commands / day | Bandwidth / day |
|---|---|---|---|
| Typical: one sporadic call or session per flush (≈ 8–12 commands per flush, ~1.5 KB) | ≈ requests, ≤ 1/min/instance | e.g. 300 calls → ≈ 3K | < 1 MB |
| Worst case (assumption above: ≤ 20 instances warm all day, each busy every minute; ≤ 500 cold starts each + salt lookup) | ≤ 20 × 1,440 + 500 ≈ 29.3K | ≤ ~1.2M (≈ 40 per busy flush; not billed on the Fixed plan, ≈ 14 commands/s) | ≤ ~180 MB (≈ 5.5 GB / month, ~11 % of 50 GB) |

`GET /stats?days=N` (1–30, default 7) with `x-stats-secret: <STATS_SECRET>` returns `days[]` (today first) and `totals`: calls / ok / errors per tool, error codes, tiers, sessions, `unique_clients_approx` (HLL `PFCOUNT`, per day; `totals.unique_client_days_approx` sums them, so a client seen on 3 days counts 3), client labels (`principals` per day; `principal_days` in the totals), degraded activations and the latency histogram with approximate `p50` / `p95` (upper edge of the bucket, e.g. `"<=250"`). One `EVALSHA` per request (3 inner reads per day). Only counts are returned; HLL members are never read. Constant-time secret comparison; an unset, wrong or missing secret all return the same 404, so the endpoint's existence is not revealed.

### Redis memory budget

The Upstash database runs with **eviction off**. Upstash has a single eviction policy ("optimistic-volatile": random keys, TTL keys first, then any key), so with eviction on, a full database would silently drop quota counters (resetting them, i.e. failing open), API key records and the suppression set. With eviction off, a full database rejects writes (`ERR DB capacity quota exceeded`) instead, so the cache has to stay well below the plan's data size (250 MB on the Fixed 250 MB plan, taken as 250 × 10^6 bytes ≈ 238 MiB) by itself. With the defaults, worst-case stored data is ≈ 2 × 64 MiB + < 1 MB + ≤ ~1 MB of usage statistics ≈ **135 MB, ~54 % of 250 MB**:

- **Daily write budget** (`CACHE_WRITE_BUDGET_BYTES`, default **64 MiB**, fleet-wide): every Redis cache write counts its stored size (value + key + 96 bytes of per-key overhead) on `eem:v1:cw:<YYYYMMDD>`, and the check and the write are **one atomic Lua script** (`EVALSHA`, `EVAL` fallback): if counter + size > budget the script returns −1 and writes nothing; otherwise it creates the counter if missing (`SET 0 NX EXAT <next midnight + 1 h>`, so the counter always has its ≤ 25 h TTL), `INCRBY`s it and `SET … EX`s the value. The counter therefore **never exceeds the budget**, whatever the number of instances or concurrent writes (tested: 10 fresh instances × 50 concurrent writes against a full counter → 0 writes; from an empty counter → exactly the budget, never more; also checked against real Upstash). Local memo, to avoid useless commands: an instance's first write of the day reads the counter once (one `GET`, shared by concurrent writes), so a cold instance facing a full counter refuses without sending any value; in-flight writes are reserved locally and replies raise the memo to max(known, fleet total + this instance's pending writes). Once the memo or the script says no, that instance skips Redis cache writes **with 0 commands** until the UTC day ends. Reads continue; the process-memory cache keeps working. `0` disables Redis cache writes.
- **TTLs end with the day**: every Redis TTL is min(normal TTL, 24 h, time until 01:00 UTC of the next day). Entries written on a UTC day are gone 1 h after it ends, so the resident cache is one day's budget, at most two (yesterday's entries plus today's writes, and only between 00:00 and 01:00 UTC): ≤ 2 × 64 MiB ≈ 134 MB. The normal TTLs are: tickers, filing documents, parsed Form 4s 24 h; XBRL frames 12 h; filing history / facts / concepts 6 h; state searches 1 h; submissions 10 min.
- **Max value** `REDIS_MAX_VALUE_BYTES` (default 256 KiB, measured after compression). Values ≥ 8 KB are stored gzip-compressed (level 6, base64, marked by a `\u0001gz1:` prefix; decompression capped at 32 MB); larger values stay in process memory only (values over 20 × the max are not even compressed). The SEC ticker file (`company_tickers_exchange.json`, ~520–585 KB) compresses to ~240 KB and is shared once a day (1 SEC request and one write per day fleet-wide instead of one SEC request per cold instance).
- **"redis full"**: if a cache write still gets a capacity error (`ERR DB capacity quota exceeded`, `OOM command not allowed`), that instance stops **only cache writes** for 10 minutes (`/health` → `redis_cache.writes: "redis full"`). Quota counters, the quota script, API keys and suppression are unaffected and keep their fail-closed / degraded handling. Plan request limits (`max requests limit`) and outages still trigger degraded mode as before.
- Non-cache data is tiny: daily counters (a few bytes each, 25 h TTL), token buckets, API key records and the suppression set.

`/health` shows `redis_cache: { writes: "on" | "redis full" | "disabled", write_budget_bytes_per_utc_day, max_value_bytes, … }` (no traffic volumes). Whether today's write budget is exhausted (a usage signal) is shown only with `?deep=1` and `x-health-secret: <HEALTH_SECRET>`, as `redis_write_budget: { state, until, known_used_bytes }`, together with `node_version` and `node_runtime_patched` (the runtime version is not in the public `/health`). `?deep=1` without a valid secret returns HTTP 401 and no health data.

## What the hosted server stores, and for how long

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
- Aggregate usage statistics (`eem:v1:stats:*`, 30 days after the end of each UTC day, production / self-hosted only, see [Usage statistics](#usage-statistics)): per-day counts per tool / outcome / error code / tier / latency bucket, session count, allowlisted client-software labels (unknown names → `other`), and an approximate unique-client count (HyperLogLog over a hash keyed with a random daily salt that is deleted at 01:00 UTC the next day; pseudonymous until then). No per-client records.
- Not stored anywhere in Redis: raw IPs, user agents, request paths, tool arguments, per-client usage history. Shared cache entries for public SEC and state data are stored under `eem:v1:c:<sha256 of the upstream request>`, so key names don't reveal what was searched; they expire after at most 24 h. The upstream fan-out budget (`eem:rl:*`) is a global token bucket with no per-client data.
- **Logs**: errors (and, with `USAGE_LOG=1`, one line per call with tool name, latency, outcome, response size and the daily-rotating principal hash) go to stderr, then to Vercel runtime logs, which expire under Vercel's plan retention ([limits](https://vercel.com/docs/logs/runtime#limits)). Error text has URL query strings, IP addresses, email addresses and credential-like values masked. Tool arguments, API keys and raw IPs are never logged by this server. Vercel's own platform request logs (outside this code) record request metadata such as path and client IP under Vercel's retention.
- Per-minute limits are kept in process memory only (70 s) and never written to Redis.
- `/health` reports this configuration under `quotas.state`.

## SEC rate limiting and caching

SEC's [fair-access policy](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) caps clients at **10 requests/second** and requires a declared User-Agent. SEC may block clients without one (HTTP 403 "Undeclared Automated Tool"). This server:
- sends `SEC_USER_AGENT` on every SEC request;
- spaces requests through a two-stage limiter: per-process spacing plus, with Redis, atomic fleet-wide token buckets (6 req/s default, 2 of them reserved for API-key callers; smooth refill, burst 2). If no token is granted within ~5 s the call fails with `RATE_LIMITED`; if Redis itself is unavailable or over its plan, anonymous callers are served from cache only and API-key callers at 0.2 req/s per instance (degraded mode);
- retries 429/5xx with exponential backoff and respects `Retry-After`;
- deduplicates identical in-flight requests and caches with TTLs: tickers 24h, submissions 10 min, companyfacts/concepts 6h, frames 12h, filing documents 24h in process memory (raw documents are never written to Redis; processed text under 256 KB and parsed Form 4s are shared for 24h), state searches 1h. No Redis cache entry lives longer than 24h.

## Production configuration

The hosted deployment is live. These are the variables it needs in the Vercel project's **Production** environment; check them before any redeploy or migration (the Preview environment carries copies of the non-Redis secrets too, but has no Redis; see the note below). With Redis configured, the server refuses to serve (HTTP 503, `/health` → `misconfigured`) until `IP_HASH_SALT` and `API_KEY_SECRET` are valid.

> **Redis is Production-only.** Since 2026-10-29 the Upstash integration variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN`) are scoped to **Production only**. Preview and Development deployments run without Redis: they use the in-memory cache and in-memory (per-instance) limits and never read or write production data (cache, quota counters, API key records, suppression set or usage statistics). **Caveat:** re-connecting or re-configuring the Upstash integration in Vercel can re-add the Preview/Development scopes, so re-check `vercel env ls` after any integration change and remove them again if they reappear.

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

Also recommended: Upstash usage alerts, and `REVOKED_KEY_IDS` kept empty unless needed. Mint keys only after `API_KEY_SECRET` is final (rotating it invalidates them).

## Library hooks

- **HTTP gate**: self-verifying keys registered in Redis (`scripts/create-key.ts` / `scripts/delete-key.ts`), `MCP_API_KEYS` static keys, or `createHttpHandler({ verifyKey: async (k) => principalOrNull })` for keys stored elsewhere. Invalid keys get 401.
- **Per-call usage hooks**: `setUsageHooks({ beforeCall, afterCall })` (exported from the package). `beforeCall` receives `{tool, transport, apiKey, clientId, principal, args}`; throwing a `ToolError` rejects the call with that code (anything else becomes `UNAUTHORIZED`). The built-in quota hook runs first. `afterCall` receives `{ok, ms, errorCode, responseChars}`, for custom metering or logging.
