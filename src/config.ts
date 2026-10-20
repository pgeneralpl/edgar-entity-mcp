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
}

export const DEFAULT_SEC_USER_AGENT = `${PACKAGE_NAME}/${VERSION} contact@example.com`;

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ua = env.SEC_USER_AGENT?.trim();
  return {
    secUserAgent: ua || DEFAULT_SEC_USER_AGENT,
    secUserAgentIsDefault: !ua,
    // SEC fair-access limit is 10 req/s per client. Stay comfortably below it.
    secMaxRps: Math.min(num(env.SEC_MAX_RPS, 8), 9),
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
