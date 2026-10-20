import { loadConfig } from "../config.js";
import { PACKAGE_NAME, VERSION } from "../version.js";
import { SUPPORTED_STATES } from "../states/registry.js";

/** Public health payload. Reports configuration *shape* only, never secret values. */
export function healthPayload(env: NodeJS.ProcessEnv = process.env) {
  const c = loadConfig(env);
  return {
    status: "ok",
    name: PACKAGE_NAME,
    version: VERSION,
    mcp_endpoint: "/mcp",
    cache: c.upstashUrl && c.upstashToken ? "upstash+memory" : "memory",
    sec_user_agent_configured: !c.secUserAgentIsDefault,
    auth_required: Boolean(env.MCP_API_KEYS?.trim()),
    states: SUPPORTED_STATES,
  };
}

export function healthResponse(): Response {
  return new Response(JSON.stringify(healthPayload()), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
