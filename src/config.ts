import { createHash } from "node:crypto";
import { PACKAGE_NAME, VERSION } from "./version.js";

/** Runtime configuration, read lazily from the environment so tests can override it. */
export interface Config {
  secUserAgent: string;
  secUserAgentIsDefault: boolean;
  secMaxRps: number;
  socrataAppToken?: string;
  socrataMaxRps: number;
  upstashUrl?: string;
  upstashToken?: string;
  cachePrefix: string;
  memoryCacheMb: number;
  redisMaxValueBytes: number;
  httpTimeoutMs: number;
  apiKeys: string[];
  usageLog: boolean;
  /** True when SEC_USER_AGENT is set, is not the placeholder, and contains a contact email. */
  secUserAgentValid: boolean;
  /** Require an API key on the HTTP transport (anonymous calls rejected). */
  requireApiKey: boolean;
  quota: { anonPerMinute: number; anonPerDay: number; anonNetworkPerDay: number; keyPerMinute: number; keyPerDay: number };
  /** Salt for hashing client IPs before they are used as Redis keys. */
  /** Secret for the daily-rotating IP hash salt (see core/apiKeys.ts daySalt). */
  ipHashSecret: string;
  ipHashSecretSource: "env" | "redis-token" | "builtin";
  /** Where users can request a free API key (shown in RATE_LIMITED hints). */
  keyRequestUrl: string;
  /** Shared secret for /health?deep=1 (header x-health-secret). Unset = deep checks disabled. */
  healthSecret?: string;
  maxBodyBytes: number;
  maxDocumentBytes: number;
  suppressionFile?: string;
}

export const DEFAULT_SEC_USER_AGENT = `${PACKAGE_NAME}/${VERSION} contact@example.com`;

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** SEC asks for "Company/Name contact@domain". Reject unset, the placeholder, or values with no email. */
export function isValidSecUserAgent(ua: string | undefined): boolean {
  if (!ua) return false;
  if (/contact@example\.com/i.test(ua)) return false;
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ua = env.SEC_USER_AGENT?.trim();
  return {
    secUserAgent: ua || DEFAULT_SEC_USER_AGENT,
    secUserAgentIsDefault: !ua,
    // SEC fair-access limit is 10 req/s per client. Stay comfortably below it (fleet-wide when Redis is configured).
    secMaxRps: Math.min(num(env.SEC_MAX_RPS, 6), 8),
    socrataAppToken: env.SOCRATA_APP_TOKEN?.trim() || undefined,
    socrataMaxRps: num(env.SOCRATA_MAX_RPS, 5),
    upstashUrl: env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim() || undefined,
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim() || undefined,
    cachePrefix: env.CACHE_PREFIX?.trim() || "eem:v1:",
    memoryCacheMb: num(env.MEMORY_CACHE_MB, 128),
    redisMaxValueBytes: num(env.REDIS_MAX_VALUE_BYTES, 900_000),
    httpTimeoutMs: num(env.HTTP_TIMEOUT_MS, 25_000),
    apiKeys: (env.MCP_API_KEYS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    usageLog: env.USAGE_LOG === "1" || env.USAGE_LOG === "true",
    secUserAgentValid: isValidSecUserAgent(ua),
    requireApiKey: env.MCP_REQUIRE_API_KEY === "1" || env.MCP_REQUIRE_API_KEY === "true",
    quota: {
      anonPerMinute: num(env.QUOTA_ANON_PER_MINUTE, 30),
      anonPerDay: num(env.QUOTA_ANON_PER_DAY, 300),
      anonNetworkPerDay: num(env.QUOTA_ANON_NETWORK_PER_DAY, 3000),
      keyPerMinute: num(env.QUOTA_KEY_PER_MINUTE, 120),
      keyPerDay: num(env.QUOTA_KEY_PER_DAY, 5000),
    },
    ...ipHashSecret(env),
    keyRequestUrl: env.KEY_REQUEST_URL?.trim() || "https://github.com/pgeneralpl/edgar-entity-mcp/issues/new?title=Free+API+key+request",
    healthSecret: env.HEALTH_SECRET?.trim() || undefined,
    maxBodyBytes: num(env.MAX_BODY_BYTES, 64 * 1024),
    maxDocumentBytes: num(env.MAX_DOCUMENT_BYTES, 15 * 1024 * 1024),
    suppressionFile: env.SUPPRESSION_FILE?.trim() || undefined,
  };
}

/**
 * IP_HASH_SALT if set; otherwise derived from the (secret) Upstash token so a fleet sharing one
 * Redis still agrees on hashes; otherwise a built-in constant (memory-only self-hosting).
 */
function ipHashSecret(env: NodeJS.ProcessEnv): Pick<Config, "ipHashSecret" | "ipHashSecretSource"> {
  const s = env.IP_HASH_SALT?.trim();
  if (s) return { ipHashSecret: s, ipHashSecretSource: "env" };
  const tok = (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN)?.trim();
  if (tok) return { ipHashSecret: createHash("sha256").update("edgar-entity-mcp/ip-salt|" + tok).digest("hex"), ipHashSecretSource: "redis-token" };
  return { ipHashSecret: "edgar-entity-mcp", ipHashSecretSource: "builtin" };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
/** For tests. */
export function resetConfig(c?: Config): void {
  cached = c;
}
