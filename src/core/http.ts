import { config, higherLimitsHint } from "../config.js";
import { cached, getRedis, type CacheOptions } from "./cache.js";
import { HttpError, ToolError } from "./errors.js";
import { ClientSlots, RateLimiter, upstashTokenBucket } from "./rateLimiter.js";
import { currentContext } from "./context.js";
import { redisDegraded } from "./degraded.js";

export type Source = "sec" | "socrata";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let secLimiter: RateLimiter | undefined;
let socrataLimiter: RateLimiter | undefined;
let slots: ClientSlots | undefined;

function limiterFor(source: Source): RateLimiter {
  const c = config();
  const distributed = process.env.DISTRIBUTED_RATE_LIMIT !== "0" && process.env.SEC_DISTRIBUTED_RATE_LIMIT !== "0";
  const redis = distributed ? getRedis() : undefined;
  if (source === "sec") {
    if (!secLimiter) {
      // H-a: part of the fleet SEC budget is reserved for API-key callers.
      const reserved = c.secKeyedReservedRps;
      const shared = Math.max(1, c.secMaxRps - reserved);
      secLimiter = new RateLimiter(
        c.secMaxRps,
        redis ? { shared: upstashTokenBucket(redis, shared, "sec"), reserved: reserved > 0 ? upstashTokenBucket(redis, reserved, "sec-keyed") : undefined } : undefined,
        { name: "SEC", degradedRps: c.degradedSecRps },
      );
    }
    return secLimiter;
  }
  if (!socrataLimiter)
    socrataLimiter = new RateLimiter(c.socrataMaxRps, redis ? upstashTokenBucket(redis, c.socrataMaxRps, "socrata") : undefined, { name: "state-registry", degradedRps: 1 });
  return socrataLimiter;
}

/** For tests: drop limiter singletons so config changes take effect. */
export function resetLimiters(): void {
  secLimiter = undefined;
  socrataLimiter = undefined;
  slots = undefined;
}

function clientSlots(): ClientSlots {
  if (!slots) slots = new ClientSlots(config().maxConcurrentUpstreamPerClient);
  return slots;
}

/** Stats for observability / tests. */
export const httpStats = { requests: 0, retries: 0, cacheMisses: 0 };

const SEC_HOSTS = new Set(["www.sec.gov", "data.sec.gov"]);
export const SOCRATA_HOSTS = new Set(["data.ny.gov", "data.colorado.gov", "data.oregon.gov", "data.ct.gov", "data.pa.gov"]);

/** Validate an SEC URL and return it canonicalised (https, allowlisted host, no query/fragment). */
export function assertSecUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError("INVALID_INPUT", "Invalid URL.");
  }
  if (u.protocol !== "https:" || !SEC_HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== "443"))
    throw new ToolError("INVALID_INPUT", "Only https://www.sec.gov and https://data.sec.gov URLs are allowed.");
  u.search = "";
  u.hash = "";
  u.port = "";
  return u;
}

const FILING_DOC_PATH = /^\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[\w.-]{1,200}$/;

/**
 * Strict validation for user-supplied filing document URLs:
 * https://www.sec.gov/Archives/edgar/data/<cik>/<18-digit accession>/<file>, query/fragment stripped.
 * The inline XBRL viewer form (https://www.sec.gov/ix?doc=/Archives/...) is unwrapped first.
 */
export function validateFilingDocUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ToolError("INVALID_INPUT", "Invalid URL.");
  }
  if (u.protocol === "https:" && u.hostname === "www.sec.gov" && /^\/(cgi-bin\/viewer|ix)$/.test(u.pathname) && u.searchParams.get("doc")) {
    u = new URL(u.searchParams.get("doc")!, "https://www.sec.gov");
  }
  const bad = () =>
    new ToolError("INVALID_INPUT", "url must be a filing document on www.sec.gov of the form https://www.sec.gov/Archives/edgar/data/<CIK>/<18-digit accession>/<file>.", "Use the url returned by list_filings, or pass company + accession.");
  if (u.protocol !== "https:" || u.hostname !== "www.sec.gov" || u.username || u.password || (u.port && u.port !== "443")) throw bad();
  if (!FILING_DOC_PATH.test(u.pathname) || u.pathname.includes("..")) throw bad();
  return `https://www.sec.gov${u.pathname}`;
}

function assertAllowedUrl(url: string, source: Source): string {
  if (source === "sec") return assertSecUrl(url).toString();
  const u = new URL(url);
  if (u.protocol !== "https:" || !SOCRATA_HOSTS.has(u.hostname)) throw new ToolError("INVALID_INPUT", "Host not allowed.");
  return u.toString();
}

/** L5: refuse SEC calls without an identifying User-Agent (SEC fair-access policy). */
export function assertSecUserAgent(): void {
  if (!config().secUserAgentValid)
    throw new ToolError(
      "CONFIG_ERROR",
      "SEC_USER_AGENT is not set. The SEC requires every client to identify itself with a name and contact email.",
      'Set the SEC_USER_AGENT environment variable to your own "<Name or Company> <email>", e.g. "Jane Doe jane@example.org", in your MCP client config (env block) and restart.',
    );
}

function headersFor(source: Source, accept?: string): Record<string, string> {
  const c = config();
  const h: Record<string, string> = { "Accept-Encoding": "gzip, deflate", "User-Agent": c.secUserAgent };
  if (accept) h.Accept = accept;
  if (source === "socrata" && c.socrataAppToken) h["X-App-Token"] = c.socrataAppToken;
  return h;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 3;
/** Default cap for API responses (companyfacts for the largest filers is tens of MB). */
const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;

/** Read a response body as text, aborting once more than maxBytes have been received. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  const tooBig = () => new ToolError("UNSUPPORTED", `Upstream document is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, "Open the filing index and pick a smaller document or exhibit.");
  if (Number.isFinite(len) && len > maxBytes && !res.headers.get("content-encoding")) {
    await res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

export interface FetchOptions {
  accept?: string;
  maxAttempts?: number;
  /** Hard cap on the decompressed body size. */
  maxBytes?: number;
}

/** Raw fetch with rate limiting, retry/backoff on 429/5xx, manual redirects (host re-checked), body cap. No caching. */
export async function fetchRaw(url: string, source: Source, opts: FetchOptions = {}): Promise<string> {
  if (source === "sec") assertSecUserAgent();
  const ctx = currentContext();
  // M1: in degraded mode anonymous HTTP callers are served from cache only (anything reaching
  // fetchRaw was not cached). API-key callers continue at the degraded per-instance rate.
  if (ctx?.transport === "http" && ctx.principal?.tier !== "key" && redisDegraded() && getRedis())
    throw new ToolError(
      "RATE_LIMITED",
      "The hosted server is in degraded mode (its shared rate-limit store is unavailable), so anonymous requests are answered from cache only, and this data is not cached.",
      `Retry in a few minutes, or run the server locally with \`npx -y edgar-entity-mcp\`. ${higherLimitsHint(config().keyRequestUrl)}`,
      { retry_after_seconds: 120, scope: "degraded" },
    );
  return clientSlots().run(ctx?.transport === "http" ? ctx.principal?.id : undefined, () => fetchRawInner(url, source, opts, ctx?.principal?.tier ?? "anon"));
}

async function fetchRawInner(url: string, source: Source, opts: FetchOptions, tier: "anon" | "key"): Promise<string> {
  let target = assertAllowedUrl(url, source);
  const maxAttempts = opts.maxAttempts ?? 4;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const limiter = limiterFor(source);
  let lastErr: unknown;
  let redirects = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await limiter.acquire(tier); // RATE_LIMITED when the fleet budget is exhausted; degraded local rate if Redis is down
    httpStats.requests++;
    const cctx = currentContext();
    if (cctx) cctx.upstream = (cctx.upstream ?? 0) + 1; // actual cost, for quota settlement
    try {
      const res = await fetch(target, {
        headers: headersFor(source, opts.accept),
        signal: AbortSignal.timeout(config().httpTimeoutMs),
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (++redirects > MAX_REDIRECTS) throw new HttpError(508, target, "Too many redirects");
        target = assertAllowedUrl(new URL(res.headers.get("location")!, target).toString(), source);
        attempt--; // a redirect is not a failed attempt
        continue;
      }
      if (res.ok) return await readCapped(res, maxBytes);
      const body = await readCapped(res, 64 * 1024).catch(() => "");
      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        httpStats.retries++;
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(Math.min(backoff, 10_000));
        continue;
      }
      let msg = `HTTP ${res.status} for ${target}`;
      if (source === "socrata" && body) {
        try {
          const j = JSON.parse(body) as { message?: string };
          if (j.message) msg += `: ${j.message.slice(0, 300)}`;
        } catch {
          /* ignore */
        }
      }
      throw new HttpError(res.status, target, msg);
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError || err instanceof ToolError) throw err;
      // network error / timeout: retry
      if (attempt < maxAttempts) {
        httpStats.retries++;
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
    }
  }
  throw lastErr;
}

const inflight = new Map<string, Promise<unknown>>();

/** Coalesce identical concurrent requests. */
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface GetOptions extends CacheOptions {
  accept?: string;
  maxBytes?: number;
}

/** GET text with caching (string stored as-is). Cache keys use the canonicalised URL. */
export function getText(url: string, source: Source, ttlSeconds: number, opts: GetOptions = {}): Promise<string> {
  const key = assertAllowedUrl(url, source);
  return dedupe(`t:${key}`, () =>
    cached<string>(
      `raw:${key}`,
      ttlSeconds,
      async () => {
        httpStats.cacheMisses++;
        return fetchRaw(key, source, { accept: opts.accept, maxBytes: opts.maxBytes });
      },
      { tier: opts.tier },
    ),
  );
}

/** GET + JSON.parse with caching of the raw body. */
export async function getJson<T>(url: string, source: Source, ttlSeconds: number, opts: CacheOptions = {}): Promise<T> {
  const text = await getText(url, source, ttlSeconds, { accept: "application/json", tier: opts.tier });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError("UPSTREAM_ERROR", "Upstream returned a non-JSON response.");
  }
}

/** Cache a derived (post-processed) value keyed by name, deduping concurrent work. */
export function derived<T>(key: string, ttlSeconds: number, fn: () => Promise<T>, opts: CacheOptions = {}): Promise<T> {
  return dedupe(`d:${key}`, () => cached<T>(`d:${key}`, ttlSeconds, fn, opts));
}
