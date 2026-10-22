import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { SUPPORTED_STATES } from "../states/registry.js";
import { getRedis } from "../core/cache.js";
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
    // Only whether the runtime has the 2026-10-21 Node.js security fixes; the exact version is not exposed.
    node_runtime_patched: isPatchedNode(),
    auth_required: c.requireApiKey,
    states: SUPPORTED_STATES,
  };
}

function secretMatches(given: string | null, secret: string | undefined): boolean {
  if (!secret || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * `?deep=1` with header `x-health-secret: <HEALTH_SECRET>` adds a Redis PING.
 * Without a matching secret the deep check is silently skipped. Errors are never echoed.
 */
export async function healthResponse(req?: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const body: Record<string, unknown> = healthPayload(env);
  if (req && new URL(req.url).searchParams.get("deep") === "1") {
    if (!secretMatches(req.headers.get("x-health-secret"), loadConfig(env).healthSecret)) {
      body.deep = "skipped (requires x-health-secret)";
    } else {
      const redis = getRedis();
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
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
