import { createHmac } from "node:crypto";
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
  quota: { anonPerMinute: number; anonPerDay: number; anonNetworkPerDay: number; anonGlobalPerDay: number; keyPerMinute: number; keyPerDay: number };
  /** Secret for the daily-rotating IP hash salt (see core/apiKeys.ts daySalt). */
  ipHashSecret: string;
  ipHashSecretSource: "env" | "builtin";
  /** Secret for API key MACs (API_KEY_SECRET, else derived from IP_HASH_SALT). */
  apiKeySecret: string;
  /** Set when the HTTP server must refuse to serve (e.g. Redis on but no strong IP_HASH_SALT). */
  startupProblem?: string;
  /** SEC requests/second reserved for API-key callers (out of secMaxRps). */
  secKeyedReservedRps: number;
  /** Local SEC rate while Redis is unavailable (degraded mode). */
  degradedSecRps: number;
  /** Max concurrent upstream fetches per client (per instance). */
  maxConcurrentUpstreamPerClient: number;
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
      anonNetworkPerDay: num(env.QUOTA_ANON_NETWORK_PER_DAY, 1500),
      anonGlobalPerDay: num(env.QUOTA_ANON_GLOBAL_PER_DAY, 2000),
      keyPerMinute: num(env.QUOTA_KEY_PER_MINUTE, 120),
      keyPerDay: num(env.QUOTA_KEY_PER_DAY, 2000),
    },
    ...secrets(env),
    secKeyedReservedRps: Math.min(num(env.SEC_KEYED_RESERVED_RPS, 2), Math.max(0, Math.min(num(env.SEC_MAX_RPS, 6), 8) - 1)),
    degradedSecRps: Math.min(num(env.DEGRADED_SEC_RPS, 1), 2),
    maxConcurrentUpstreamPerClient: num(env.MAX_CONCURRENT_UPSTREAM_PER_CLIENT, 4),
    keyRequestUrl: env.KEY_REQUEST_URL?.trim() || "https://github.com/pgeneralpl/edgar-entity-mcp/issues/new?title=Free+API+key+request",
    healthSecret: env.HEALTH_SECRET?.trim() || undefined,
    maxBodyBytes: num(env.MAX_BODY_BYTES, 64 * 1024),
    maxDocumentBytes: num(env.MAX_DOCUMENT_BYTES, 15 * 1024 * 1024),
    suppressionFile: env.SUPPRESSION_FILE?.trim() || undefined,
  };
}

export const BUILTIN_IP_HASH_SALT = "edgar-entity-mcp";
export const MIN_SECRET_LENGTH = 32;

/**
 * IP_HASH_SALT (secret, >= 32 chars) is mandatory whenever Redis is configured: hashes stored there
 * must not be reversible with a public salt. Without Redis nothing is persisted, so the built-in
 * value is tolerated for local/self-hosted use.
 */
function secrets(env: NodeJS.ProcessEnv): Pick<Config, "ipHashSecret" | "ipHashSecretSource" | "apiKeySecret" | "startupProblem"> {
  const s = env.IP_HASH_SALT?.trim();
  const redis = !!((env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL)?.trim() && (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN)?.trim());
  const weak = !s || s === BUILTIN_IP_HASH_SALT || s.length < MIN_SECRET_LENGTH;
  const ipHashSecret = s || BUILTIN_IP_HASH_SALT;
  const k = env.API_KEY_SECRET?.trim();
  let startupProblem: string | undefined;
  if (redis && weak) startupProblem = `IP_HASH_SALT must be set to a random secret of at least ${MIN_SECRET_LENGTH} characters when Redis is configured.`;
  else if (k && k.length < MIN_SECRET_LENGTH) startupProblem = `API_KEY_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`;
  return {
    ipHashSecret,
    ipHashSecretSource: s ? "env" : "builtin",
    apiKeySecret: k || createHmac("sha256", ipHashSecret).update("edgar-entity-mcp/api-key-mac/v1").digest("hex"),
    startupProblem,
  };
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
