import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { SUPPORTED_STATES } from "../states/registry.js";
import { REDIS_COMPRESS_MIN_BYTES, cacheWriteStatus, getRedis } from "../core/cache.js";
import { logError } from "../core/errors.js";
import { degradedStatus } from "../core/degraded.js";
import { isPatchedNode } from "../core/nodeVersion.js";

/** Public health payload. Reports configuration *shape* only, never secret values. */
export function healthPayload(env: NodeJS.ProcessEnv = process.env) {
  const c = loadConfig(env);
  const redis = !!(c.upstashUrl && c.upstashToken);
  const degraded = degradedStatus();
  return {
    // "misconfigured": Redis is on but the hashing secret is missing/weak; every request gets 503.
    status: c.startupProblem ? "misconfigured" : degraded.degraded ? "degraded" : "ok",
    ...(degraded.degraded ? { degraded: { reason: degraded.reason, since: degraded.since, mode: "local in-memory limits; anonymous callers cache-only; API-key callers at the degraded SEC rate" } } : {}),
    name: PACKAGE_NAME,
    version: VERSION,
    mcp_endpoint: "/mcp",
    cache: redis ? "upstash+memory" : "memory",
    ...(redis ? { redis_cache: redisCacheHealth(c.cacheWriteBudgetBytes, c.redisMaxValueBytes) } : {}),
    sec_rate_limit: {
      rps: c.secMaxRps,
      reserved_for_api_keys_rps: redis ? Math.min(c.secKeyedReservedRps, Math.max(0, c.secMaxRps - 1)) : 0,
      degraded_rps: c.degradedSecRps,
      max_concurrent_upstream_per_client: c.maxConcurrentUpstreamPerClient,
      scope: redis && env.SEC_DISTRIBUTED_RATE_LIMIT !== "0" && env.DISTRIBUTED_RATE_LIMIT !== "0" ? "fleet (redis)" : "instance",
    },
    quotas: {
      anonymous: { units_per_minute: c.quota.anonPerMinute, units_per_day: c.quota.anonPerDay, units_per_day_per_network: c.quota.anonNetworkPerDay,
        units_per_day_all_anonymous: { soft: c.quota.anonGlobalPerDay, hard: c.quota.anonGlobalHardPerDay, per_ip_after_soft_cap: c.quota.anonTricklePerDay },
        charging: "estimate reserved, unused part refunded after the call (minimum 1 unit)" },
      api_key: { units_per_minute: c.quota.keyPerMinute, units_per_day: c.quota.keyPerDay },
      // What rate limiting stores: integer counters under daily-rotating hashed ids, TTL = window.
      state: { ip_hash: "HMAC-SHA256, salt rotated daily (UTC)", ip_hash_secret: c.ipHashSecretSource, api_key_secret: c.apiKeySecret ? "env" : "unset (minted keys disabled)", day_counter_ttl_hours: 25, minute_limits: "in memory per instance (not stored)" },
    },
    sec_user_agent_configured: c.secUserAgentValid,
    // Runtime version / patch state is not public (it tells attackers which CVEs apply); see ?deep=1.
    auth_required: c.requireApiKey,
    states: SUPPORTED_STATES,
  };
}

/**
 * Cache-write guard state (eviction is off, so the cache bounds itself). No traffic volumes exposed:
 * whether today's write budget is spent (a usage signal) is shown only with `?deep=1` + HEALTH_SECRET.
 */
function redisCacheHealth(budgetBytes: number, maxValueBytes: number) {
  const w = cacheWriteStatus();
  const full = budgetBytes > 0 && w.writes === "redis full";
  return {
    writes: budgetBytes <= 0 ? "disabled" : full ? "redis full" : "on", // "on" | "redis full" | "disabled"
    ...(full && w.until ? { until: w.until } : {}),
    write_budget_bytes_per_utc_day: budgetBytes,
    max_value_bytes: maxValueBytes,
    compressed_from_bytes: REDIS_COMPRESS_MIN_BYTES,
    max_ttl: "24 h, and never past 01:00 UTC of the next day",
  };
}

/** Private (HEALTH_SECRET) view of today's write budget. */
function writeBudgetDetail() {
  const w = cacheWriteStatus();
  return {
    state: w.writes === "budget exhausted" ? "exhausted" : w.writes === "ok" ? "ok" : w.writes,
    ...(w.until && w.writes === "budget exhausted" ? { until: w.until } : {}),
    known_used_bytes: w.known_used_bytes,
  };
}

/** Constant-time comparison of a presented secret (hash both sides so lengths never leak). */
export function secretMatches(given: string | null, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

/**
 * `?deep=1` with header `x-health-secret: <HEALTH_SECRET>` adds the Node.js runtime version and patch
 * state, a Redis PING and today's cache-write budget state. Without a matching secret (or with
 * HEALTH_SECRET unset) `?deep=1` is refused with 401 and no health data. Errors are never echoed.
 */
export async function healthResponse(req?: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const deep = !!req && new URL(req.url).searchParams.get("deep") === "1";
  if (req && deep && !secretMatches(req.headers.get("x-health-secret"), loadConfig(env).healthSecret)) {
    return new Response(JSON.stringify({ error: "unauthorized", message: "deep health requires a valid x-health-secret header" }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }
  const body: Record<string, unknown> = healthPayload(env);
  if (deep) {
    body.node_version = process.version;
    // Whether the runtime has the 2026-10-21 Node.js security fixes (see src/core/nodeVersion.ts).
    body.node_runtime_patched = isPatchedNode();
    const redis = getRedis();
    if (redis) body.redis_write_budget = writeBudgetDetail();
    if (!redis) body.redis = "not configured";
    else {
      const t0 = Date.now();
      try {
        body.redis = { ok: (await redis.ping()) === "PONG", ms: Date.now() - t0 };
      } catch (e) {
        logError("health-redis", e);
        body.redis = { ok: false };
      }
    }
  }
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}
