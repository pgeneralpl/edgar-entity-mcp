import { createMcpHandler } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { registerAll, SERVER_INSTRUCTIONS, warnIfDefaultUserAgent } from "../server.js";
import { config, higherLimitsHint } from "../config.js";
import { getUserUsageHooks, setSystemUsageHook, setUsageHooks, stderrUsageLogger } from "../core/usage.js";
import { chargeQuota, settleQuota, type Principal, type QuotaStore } from "../core/quota.js";
import { clientIp, ipPrincipal, keyFailuresExceeded, recordKeyFailure, verifyApiKey } from "../core/apiKeys.js";
import { logError } from "../core/errors.js";
import { recordInitialize, recordToolCall } from "../core/stats.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

export interface HttpHandlerOptions {
  /** Custom key verification (returns a principal or null). Default: MCP_API_KEYS + hashed keys in Redis. */
  verifyKey?: (key: string) => Principal | null | Promise<Principal | null>;
  /** Override the quota store (tests). */
  quotaStore?: QuotaStore;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const rpcError = (status: number, code: number, message: string, data?: unknown, headers?: Record<string, string>) =>
  json(status, { jsonrpc: "2.0", id: null, error: { code, message, ...(data ? { data } : {}) } }, headers);

/**
 * The MCP transport answers with `text/event-stream` (no charset). SSE is UTF-8 by definition, but some
 * clients and proxies decode a charset-less text type as Latin-1, garbling non-ASCII (e.g. "’" in filings).
 * Re-wrap the (streaming) body with an explicit `charset=utf-8`; JSON responses are left alone.
 */
export function withUtf8Charset(res: Response): Response {
  const ct = res.headers.get("content-type");
  if (!ct || !/^text\/event-stream\b/i.test(ct) || /charset=/i.test(ct)) return res;
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Read a request body as text, refusing more than maxBytes. Returns null when too large. */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const dec = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/**
 * Build the Streamable HTTP handler (Web-standard Request -> Response).
 *
 * - Body capped at MAX_BODY_BYTES (64 KB); JSON-RPC batch (array) bodies are rejected.
 * - Auth: optional API key via `Authorization: Bearer <key>` or `x-api-key`. Invalid keys get 401.
 *   Without a key the caller is anonymous (identified by hashed IP) unless MCP_REQUIRE_API_KEY=1.
 * - Every tool call is charged against per-minute and per-day unit quotas (see core/quota.ts).
 */
let startupLogged = false;

export function createHttpHandler(opts: HttpHandlerOptions = {}): (req: Request) => Promise<Response> {
  const c = config();
  if (c.usageLog && !getUserUsageHooks().afterCall) setUsageHooks(stderrUsageLogger);
  warnIfDefaultUserAgent();
  setSystemUsageHook("quota", {
    async beforeCall(e) {
      if (e.transport === "http" && e.principal) await chargeQuota(e.principal, e.tool, e.args, opts.quotaStore);
    },
    afterCall() {
      settleQuota(); // refund estimate − actual upstream cost (local, no Redis command)
    },
  });

  // Aggregate usage counters (src/core/stats.ts): local, synchronous; Redis writes are batched in the background.
  setSystemUsageHook("stats", {
    afterCall(e) {
      recordToolCall(e);
    },
  });

  const base = createMcpHandler((server) => registerAll(server, "http"), {
    serverInfo: { name: PACKAGE_NAME, version: VERSION },
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {}, prompts: {}, resources: {} },
  });
  const verify = opts.verifyKey ?? verifyApiKey;

  return async (req: Request) => {
    // B2: refuse to serve with a weak/public IP hash salt while Redis (persistent state) is on.
    if (c.startupProblem) {
      if (!startupLogged) startupLogged = !!logError("startup", new Error(c.startupProblem));
      return rpcError(503, -32000, "Server misconfigured; refusing to serve. The operator has been notified in the logs.");
    }
    let body: string | undefined;
    let initClientInfo: unknown;
    let isInitialize = false;
    if (req.method === "POST") {
      const text = await readBodyCapped(req, c.maxBodyBytes);
      if (text === null) return rpcError(413, -32600, `Request body exceeds ${c.maxBodyBytes} bytes.`);
      body = text;
      try {
        const msg: unknown = JSON.parse(text);
        if (Array.isArray(msg))
          return rpcError(400, -32600, "JSON-RPC batch requests are not supported. Send one JSON-RPC message per HTTP request.");
        if (msg && typeof msg === "object" && (msg as { method?: unknown }).method === "initialize") {
          isInitialize = true;
          initClientInfo = (msg as { params?: { clientInfo?: unknown } }).params?.clientInfo;
        }
      } catch {
        /* not JSON: let the MCP transport produce its parse error */
      }
    }

    const authz = req.headers.get("authorization");
    const bearer = authz && /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : undefined;
    const key = bearer || req.headers.get("x-api-key")?.trim() || undefined;
    let principal: Principal | null;
    let token: string;
    if (key) {
      // In-memory limiter in front of any Redis work: too many bad keys from one client -> 429.
      const ipId = ipPrincipal(clientIp(req)).id;
      if (keyFailuresExceeded(ipId))
        return rpcError(429, -32001, "Too many invalid API keys from this client. Try again later.", { hint: "Check your API key." }, { "retry-after": "600" });
      try {
        principal = await verify(key);
      } catch (e) {
        logError("auth", e);
        return rpcError(503, -32000, "Authentication is temporarily unavailable. Retry shortly.", undefined, { "retry-after": "5" });
      }
      if (!principal) {
        recordKeyFailure(ipId);
        return rpcError(401, -32001, "Invalid API key.", { hint: `Check the key, or omit it to use the anonymous tier. ${higherLimitsHint(c.keyRequestUrl)}` }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      token = key;
    } else {
      if (c.requireApiKey) return rpcError(401, -32001, "An API key is required.", { hint: `An API key is required on this server. A person may request one at ${c.keyRequestUrl}.` }, { "www-authenticate": "Bearer" });
      principal = ipPrincipal(clientIp(req));
      token = "anonymous";
    }

    const auth: AuthInfo = { token, clientId: principal.id, scopes: [], extra: { principal } };
    const forwarded = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: body !== undefined ? body : undefined,
      signal: req.signal,
    });
    (forwarded as Request & { auth?: AuthInfo }).auth = auth;
    if (isInitialize) recordInitialize(principal, initClientInfo);
    return withUtf8Charset(await base(forwarded));
  };
}
