import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { registerAll, SERVER_INSTRUCTIONS, warnIfDefaultUserAgent } from "../server.js";
import { config } from "../config.js";
import { getUsageHooks, setUsageHooks, stderrUsageLogger } from "../core/usage.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

/**
 * Build the Streamable HTTP handler (Web-standard Request -> Response).
 *
 * Auth: if MCP_API_KEYS is set (comma-separated), requests must send
 * `Authorization: Bearer <key>` or `x-api-key: <key>`. Without it the endpoint is open
 * (free tier). Key validation is the hook point for future paid plans.
 */
export function createHttpHandler(opts: { verifyKey?: (key: string) => boolean | Promise<boolean> } = {}): (req: Request) => Promise<Response> {
  const c = config();
  if (c.usageLog && !getUsageHooks().afterCall) setUsageHooks(stderrUsageLogger);
  warnIfDefaultUserAgent();

  const base = createMcpHandler((server) => registerAll(server, "http"), {
    serverInfo: { name: PACKAGE_NAME, version: VERSION },
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {}, prompts: {}, resources: {} },
  });

  const keys = new Set(c.apiKeys);
  const required = keys.size > 0 || !!opts.verifyKey;
  const verify = async (req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
    const key = bearer ?? req.headers.get("x-api-key") ?? undefined;
    if (!key) return undefined;
    const ok = opts.verifyKey ? await opts.verifyKey(key) : keys.has(key);
    if (!ok) return undefined;
    return { token: key, clientId: `key:${key.slice(0, 6)}`, scopes: [] };
  };

  const authed = withMcpAuth(base, verify, { required });

  return async (req: Request) => {
    // x-api-key convenience: translate to a bearer token for withMcpAuth.
    if (!req.headers.get("authorization") && req.headers.get("x-api-key")) {
      const h = new Headers(req.headers);
      h.set("authorization", `Bearer ${req.headers.get("x-api-key")}`);
      req = new Request(req, { headers: h });
    }
    return authed(req);
  };
}
