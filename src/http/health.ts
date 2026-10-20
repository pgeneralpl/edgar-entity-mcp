import { loadConfig } from "../config.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { SUPPORTED_STATES } from "../states/registry.js";
import { getRedis } from "../core/cache.js";

/** Public health payload. Reports configuration *shape* only, never secret values. */
export function healthPayload(env: NodeJS.ProcessEnv = process.env) {
  const c = loadConfig(env);
  return {
    status: "ok",
    name: PACKAGE_NAME,
    version: VERSION,
    mcp_endpoint: "/mcp",
    cache: c.upstashUrl && c.upstashToken ? "upstash+memory" : "memory",
    sec_rate_limit: {
      rps: c.secMaxRps,
      scope: c.upstashUrl && c.upstashToken && env.SEC_DISTRIBUTED_RATE_LIMIT !== "0" ? "fleet (redis)" : "instance",
    },
    sec_user_agent_configured: !c.secUserAgentIsDefault,
    auth_required: Boolean(env.MCP_API_KEYS?.trim()),
    states: SUPPORTED_STATES,
  };
}

/** `?deep=1` adds a single Redis PING so operators can confirm the cache backend is reachable. */
export async function healthResponse(req?: Request): Promise<Response> {
  const body: Record<string, unknown> = healthPayload();
  if (req && new URL(req.url).searchParams.get("deep") === "1") {
    const redis = getRedis();
    if (!redis) body.redis = "not configured";
    else {
      const t0 = Date.now();
      try {
        body.redis = { ok: (await redis.ping()) === "PONG", ms: Date.now() - t0 };
      } catch (e) {
        body.redis = { ok: false, error: (e as Error).message.slice(0, 200) };
      }
    }
  }
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
