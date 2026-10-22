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
  quota: {
    anonPerMinute: number;
    anonPerDay: number;
    /** Per /24 (IPv6 /48) daily cap; never more than 10% of anonGlobalPerDay. */
    anonNetworkPerDay: number;
    /** Soft daily cap for all anonymous callers together; past it, each IP still gets anonTricklePerDay. */
    anonGlobalPerDay: number;
    /** Hard daily ceiling for all anonymous callers (trickle included). */
    anonGlobalHardPerDay: number;
    anonTricklePerDay: number;
    keyPerMinute: number;
    keyPerDay: number;
  };
  /** Secret for the daily-rotating IP hash salt (see core/apiKeys.ts daySalt). */
  ipHashSecret: string;
  ipHashSecretSource: "env" | "builtin";
  /** Secret for API key MACs (API_KEY_SECRET). Required with Redis; without it minted keys are disabled. */
  apiKeySecret?: string;
  /** Key ids (or full keys) refused even if their record still exists (REVOKED_KEY_IDS). */
  revokedKeyIds: Set<string>;
  /** Set when the HTTP server must refuse to serve (e.g. Redis on but no strong IP_HASH_SALT). */
  startupProblem?: string;
  /** SEC requests/second reserved for API-key callers (out of secMaxRps). */
  secKeyedReservedRps: number;
  /** Per-instance SEC rate for API-key callers while Redis is unavailable (degraded mode); 0 = refuse. */
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
/** Like num() but 0 is a valid value (e.g. DEGRADED_SEC_RPS=0 = refuse). */
function num0(v: string | undefined, d: number): number {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

/** SEC asks for "Company/Name contact@domain". Reject unset, the placeholder, or values with no email. */
export function isValidSecUserAgent(ua: string | undefined): boolean {
  if (!ua) return false;
  if (/contact@example\.com/i.test(ua)) return false;
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ua = env.SEC_USER_AGENT?.trim();
  const anonGlobal = num(env.QUOTA_ANON_GLOBAL_PER_DAY, 600);
  const netMax = Math.max(1, Math.ceil(anonGlobal * 0.1));
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
      anonPerDay: num(env.QUOTA_ANON_PER_DAY, 60),
      anonNetworkPerDay: Math.min(num(env.QUOTA_ANON_NETWORK_PER_DAY, netMax), netMax),
      anonGlobalPerDay: anonGlobal,
      anonGlobalHardPerDay: Math.max(anonGlobal, num(env.QUOTA_ANON_GLOBAL_HARD_PER_DAY, Math.ceil(anonGlobal * 1.5))),
      anonTricklePerDay: num0(env.QUOTA_ANON_TRICKLE_PER_DAY, 10),
      keyPerMinute: num(env.QUOTA_KEY_PER_MINUTE, 120),
      keyPerDay: num(env.QUOTA_KEY_PER_DAY, 500),
    },
    ...secrets(env),
    secKeyedReservedRps: Math.min(num(env.SEC_KEYED_RESERVED_RPS, 2), Math.max(0, Math.min(num(env.SEC_MAX_RPS, 6), 8) - 1)),
    degradedSecRps: Math.min(num0(env.DEGRADED_SEC_RPS, 0.2), 2),
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
function secrets(env: NodeJS.ProcessEnv): Pick<Config, "ipHashSecret" | "ipHashSecretSource" | "apiKeySecret" | "startupProblem" | "revokedKeyIds"> {
  const s = env.IP_HASH_SALT?.trim();
  const redis = !!((env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL)?.trim() && (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN)?.trim());
  const weak = !s || s === BUILTIN_IP_HASH_SALT || s.length < MIN_SECRET_LENGTH;
  const ipHashSecret = s || BUILTIN_IP_HASH_SALT;
  const k = env.API_KEY_SECRET?.trim();
  let startupProblem: string | undefined;
  if (redis && weak) startupProblem = `IP_HASH_SALT must be set to a random secret of at least ${MIN_SECRET_LENGTH} characters when Redis is configured.`;
  else if (redis && (!k || k.length < MIN_SECRET_LENGTH)) startupProblem = `API_KEY_SECRET must be set to a random secret of at least ${MIN_SECRET_LENGTH} characters when Redis is configured.`;
  else if (redis && k === s) startupProblem = "API_KEY_SECRET must differ from IP_HASH_SALT.";
  else if (k && k.length < MIN_SECRET_LENGTH) startupProblem = `API_KEY_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`;
  // Accept ids ("Ab3…") or full keys ("eem_<id>_<mac>"); env keys by their "env<sha12>" id.
  const revokedKeyIds = new Set(
    (env.REVOKED_KEY_IDS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => /^eem_([A-Za-z0-9]{12})_[0-9a-f]{24}$/.exec(x)?.[1] ?? x),
  );
  return {
    ipHashSecret,
    ipHashSecretSource: s ? "env" : "builtin",
    apiKeySecret: k && k.length >= MIN_SECRET_LENGTH ? k : undefined,
    revokedKeyIds,
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
