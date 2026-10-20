import { config } from "../config.js";
import { cached } from "./cache.js";
import { getRedis } from "./cache.js";
import { HttpError, ToolError } from "./errors.js";
import { RateLimiter } from "./rateLimiter.js";

export type Source = "sec" | "socrata";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let secLimiter: RateLimiter | undefined;
let socrataLimiter: RateLimiter | undefined;

function limiterFor(source: Source): RateLimiter {
  const c = config();
  if (source === "sec") {
    if (!secLimiter) {
      const distributed = process.env.SEC_DISTRIBUTED_RATE_LIMIT !== "0";
      secLimiter = new RateLimiter(c.secMaxRps, distributed ? getRedis() : undefined, "rl:sec");
    }
    return secLimiter;
  }
  if (!socrataLimiter) socrataLimiter = new RateLimiter(c.socrataMaxRps);
  return socrataLimiter;
}

/** Stats for observability / tests. */
export const httpStats = { requests: 0, retries: 0, cacheMisses: 0 };

const SEC_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "efts.sec.gov"]);

export function assertSecUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError("INVALID_INPUT", `Invalid URL: ${url}`);
  }
  if (u.protocol !== "https:" || !SEC_HOSTS.has(u.hostname))
    throw new ToolError("INVALID_INPUT", `Only https://www.sec.gov / data.sec.gov URLs are allowed, got ${u.hostname}`);
  return u;
}

function headersFor(source: Source, accept?: string): Record<string, string> {
  const c = config();
  const h: Record<string, string> = { "Accept-Encoding": "gzip, deflate" };
  if (accept) h.Accept = accept;
  if (source === "sec") {
    h["User-Agent"] = c.secUserAgent;
  } else {
    h["User-Agent"] = c.secUserAgent; // harmless, identifies the client
    if (c.socrataAppToken) h["X-App-Token"] = c.socrataAppToken;
  }
  return h;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Raw fetch with rate limiting + retry/backoff on 429/5xx. No caching. */
export async function fetchRaw(url: string, source: Source, opts: { accept?: string; maxAttempts?: number } = {}): Promise<string> {
  if (source === "sec") assertSecUrl(url);
  const maxAttempts = opts.maxAttempts ?? 4;
  const limiter = limiterFor(source);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await limiter.acquire();
    httpStats.requests++;
    try {
      const res = await fetch(url, {
        headers: headersFor(source, opts.accept),
        signal: AbortSignal.timeout(config().httpTimeoutMs),
        redirect: "follow",
      });
      if (res.ok) return await res.text();
      const body = await res.text().catch(() => "");
      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        httpStats.retries++;
        const ra = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(Math.min(backoff, 10_000));
        continue;
      }
      let msg = `HTTP ${res.status} for ${url}`;
      if (source === "socrata" && body) {
        try {
          const j = JSON.parse(body) as { message?: string };
          if (j.message) msg += `: ${j.message}`;
        } catch {
          /* ignore */
        }
      }
      throw new HttpError(res.status, url, msg);
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
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

/** GET text with caching (string stored as-is). */
export function getText(url: string, source: Source, ttlSeconds: number, accept?: string): Promise<string> {
  return dedupe(`t:${url}`, () =>
    cached<string>(`raw:${url}`, ttlSeconds, async () => {
      httpStats.cacheMisses++;
      return fetchRaw(url, source, { accept });
    }),
  );
}

/** GET + JSON.parse with caching of the raw body. */
export async function getJson<T>(url: string, source: Source, ttlSeconds: number): Promise<T> {
  const text = await getText(url, source, ttlSeconds, "application/json");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError("UPSTREAM_ERROR", `Upstream returned non-JSON for ${url}`);
  }
}

/** Cache a derived (post-processed) value keyed by name, deduping concurrent work. */
export function derived<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  return dedupe(`d:${key}`, () => cached<T>(`d:${key}`, ttlSeconds, fn));
}
