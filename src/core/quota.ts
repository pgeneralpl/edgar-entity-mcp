import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { config } from "../config.js";
import { ToolError, logError } from "./errors.js";
import { getRedis } from "./cache.js";
import { markRedisDegraded, redisDegraded } from "./degraded.js";

/**
 * Per-client quotas for the hosted HTTP endpoint, in "units" that approximate upstream cost
 * (≈ number of SEC / state-portal requests a call can trigger).
 */
export type Tier = "anon" | "key";

export interface Principal {
  /** Stable, non-reversible id: "ip:<hash>" or "key:<hash prefix>". */
  id: string;
  tier: Tier;
  /** Per-key overrides (from the key record). */
  perDay?: number;
  perMinute?: number;
  /** Hashed enclosing network (IPv4 /24, IPv6 /48) for anonymous clients. */
  network?: string;
  /** UTC day (YYYYMMDD) the ids were derived for; daily counters use the same day. */
  day?: string;
  /** Key accepted on its MAC alone because Redis was unavailable (revocation not checked). */
  unverified?: boolean;
}

export interface Limits {
  perMinute: number;
  perDay: number;
  /** Daily cap shared by all anonymous clients of one network (limits IP rotation). */
  networkPerDay?: number;
  /** Daily cap shared by ALL anonymous clients of the deployment. */
  globalPerDay?: number;
}

export interface QuotaDecision {
  ok: boolean;
  scope?: "minute" | "day" | "network" | "global";
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface QuotaStore {
  consume(p: Principal, cost: number, limits: Limits): Promise<QuotaDecision>;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Approximate upstream fan-out of one tool call. 0 = purely local, not metered. */
export function toolCost(tool: string, args: unknown): number {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "list_supported_states":
      return 0;
    case "search_company":
    case "get_company_profile":
    case "get_xbrl_concept":
      return 1;
    case "list_filings":
      // tickers + submissions + up to LIST_MAX_HISTORY_PAGES (4) older-history pages
      return a.date_from || a.date_to || num(a.offset, 0) > 0 ? 6 : 1;
    case "get_financials":
      return 2; // companyfacts is a large document
    case "compare_companies":
      return 3; // frames responses cover every filer
    case "get_filing_document":
      // url: document + up to 3 redirects; company+accession adds tickers, submissions and up to 4 history pages
      return a.url ? 4 : 10;
    case "get_insider_trades":
      // tickers + submissions + up to 4 history pages + one Form 4 per filing (max 20)
      return 6 + Math.min(Math.max(1, Math.floor(num(a.limit, 10))), 20);
    case "lookup_business_entity": {
      const st = Array.isArray(a.states) && a.states.length ? new Set(a.states).size : 5;
      return Math.min(st, 5);
    }
    default:
      return 2;
  }
}

export function limitsFor(p: Principal): Limits {
  const q = config().quota;
  if (p.tier === "key") return { perMinute: p.perMinute ?? q.keyPerMinute, perDay: p.perDay ?? q.keyPerDay };
  return { perMinute: q.anonPerMinute, perDay: q.anonPerDay, networkPerDay: q.anonNetworkPerDay, globalPerDay: q.anonGlobalPerDay };
}

/**
 * Retention = enforced window. Daily counters live 25 h (the UTC day + 1 h slack for clock skew);
 * per-minute counters 70 s (the minute + 10 s slack). Nothing else is stored.
 */
export const DAY_COUNTER_TTL_SECONDS = 25 * 3600;
export const MINUTE_COUNTER_TTL_SECONDS = 70;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}
export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

/** One counter checked and incremented atomically. Order matters: long windows first. */
interface Counter {
  id: string;
  scope: NonNullable<QuotaDecision["scope"]>;
  limit: number;
  window: "day" | "minute";
}

function countersFor(p: Principal, l: Limits, now: number): { counters: Counter[]; day: string; minute: number } {
  const day = p.day ?? utcDay(now);
  const minute = Math.floor(now / 60_000);
  const counters: Counter[] = [{ id: `q:d:${p.id}:${day}`, scope: "day", limit: l.perDay, window: "day" }];
  if (p.network && l.networkPerDay) counters.push({ id: `q:d:${p.network}:${day}`, scope: "network", limit: l.networkPerDay, window: "day" });
  if (p.tier === "anon" && l.globalPerDay) counters.push({ id: `q:d:anon:${day}`, scope: "global", limit: l.globalPerDay, window: "day" });
  counters.push({ id: `q:m:${p.id}:${minute}`, scope: "minute", limit: l.perMinute, window: "minute" });
  return { counters, day, minute };
}

function blockedDecision(c: Counter, used: number, now: number, minute: number): QuotaDecision {
  const retry = c.window === "day" ? secondsToUtcMidnight(now) : Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
  return { ok: false, scope: c.scope, limit: c.limit, remaining: Math.max(0, c.limit - used), retryAfterSeconds: retry };
}

/** In-process store (self-hosted HTTP without Redis, degraded mode, and tests). Same semantics as Redis. */
export class MemoryQuotaStore implements QuotaStore {
  private counts = new Map<string, { v: number; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  async consume(p: Principal, cost: number, l: Limits): Promise<QuotaDecision> {
    const t = this.now();
    if (this.counts.size > 20_000) for (const [k, v] of this.counts) if (v.exp <= t) this.counts.delete(k);
    const { counters, minute } = countersFor(p, l, t);
    const get = (id: string) => {
      const e = this.counts.get(id);
      return e && e.exp > t ? e.v : 0;
    };
    for (const c of counters) {
      const used = get(c.id);
      if (used + cost > c.limit) return blockedDecision(c, used, t, minute);
    }
    for (const c of counters)
      this.counts.set(c.id, { v: get(c.id) + cost, exp: t + 1000 * (c.window === "day" ? DAY_COUNTER_TTL_SECONDS : MINUTE_COUNTER_TTL_SECONDS) });
    const d = counters[0]!;
    return { ok: true, limit: d.limit, remaining: d.limit - get(d.id) };
  }
}

/**
 * ALL quota counters in ONE Redis command (EVALSHA): MGET every counter, refuse if any would
 * exceed its limit (reporting the first, longest-window one), otherwise INCRBY each and set its TTL
 * on first use. Values are integers; keys are hashed ids + window number.
 */
const QUOTA_SCRIPT = `
local cost = tonumber(ARGV[1])
local n = #KEYS
local used = redis.call('MGET', unpack(KEYS))
for i = 1, n do
  local u = tonumber(used[i] or '0')
  if u + cost > tonumber(ARGV[1 + i]) then return {0, i, u} end
end
local first = 0
for i = 1, n do
  local v = redis.call('INCRBY', KEYS[i], cost)
  if v == cost then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[1 + n + i])) end
  if i == 1 then first = v end
end
return {1, 0, first}
`;
export const QUOTA_SCRIPT_SHA = createHash("sha1").update(QUOTA_SCRIPT).digest("hex");

/**
 * Redis store. Allowed call = 1 Redis command. Blocks are memoised in memory until the window ends
 * (UTC midnight for day / network / global caps), so repeat calls from a blocked client, network or
 * an exhausted global budget cost 0 Redis commands on this instance.
 */
export class UpstashQuotaStore implements QuotaStore {
  private blocked = new Map<string, { until: number; d: QuotaDecision }>();
  constructor(
    private redis: Redis,
    private prefix = config().cachePrefix,
    private now: () => number = Date.now,
  ) {}
  private async exec(keys: string[], args: string[]): Promise<unknown> {
    try {
      return await this.redis.evalsha(QUOTA_SCRIPT_SHA, keys, args);
    } catch (e) {
      if (!/NOSCRIPT/i.test(String(e))) throw e;
      return await this.redis.eval(QUOTA_SCRIPT, keys, args);
    }
  }
  async consume(p: Principal, cost: number, l: Limits): Promise<QuotaDecision> {
    const t = this.now();
    const { counters, minute } = countersFor(p, l, t);
    for (const c of counters) {
      const b = this.blocked.get(c.id);
      if (b && b.until > t) return { ...b.d, retryAfterSeconds: Math.max(1, Math.ceil((b.until - t) / 1000)) };
    }
    const keys = counters.map((c) => this.prefix + c.id);
    const args = [String(cost), ...counters.map((c) => String(c.limit)), ...counters.map((c) => String(c.window === "day" ? DAY_COUNTER_TTL_SECONDS : MINUTE_COUNTER_TTL_SECONDS))];
    const [ok, idx, val] = ((await this.exec(keys, args)) as [number, number, number]).map(Number) as [number, number, number];
    if (ok === 1) return { ok: true, limit: counters[0]!.limit, remaining: counters[0]!.limit - val };
    const c = counters[idx - 1]!;
    const d = blockedDecision(c, val, t, minute);
    // A full counter only grows within its window, so the block holds until the window ends.
    // (Cheaper calls might still fit; only cache when not even a 1-unit call would.)
    if (val + 1 > c.limit || cost <= 1) {
      if (this.blocked.size > 10_000) this.blocked.clear();
      this.blocked.set(c.id, { until: t + d.retryAfterSeconds! * 1000, d });
    }
    return d;
  }
}

let store: QuotaStore | undefined;
const fallback = new MemoryQuotaStore();
export function getQuotaStore(): QuotaStore {
  if (!store) {
    const r = getRedis();
    store = r ? new UpstashQuotaStore(r) : fallback;
  }
  return store;
}
export function setQuotaStore(s: QuotaStore | undefined): void {
  store = s;
}

export function rateLimitedError(p: Principal, d: QuotaDecision, cost: number): ToolError {
  const c = config();
  const who =
    d.scope === "global"
      ? "all anonymous clients of this server combined"
      : d.scope === "network"
        ? "all anonymous clients in your network (/24)"
        : p.tier === "anon"
          ? "anonymous clients (per IP)"
          : "this API key";
  const per = d.scope === "minute" ? "minute" : "day (UTC)";
  const hint =
    p.tier === "anon"
      ? `Retry after ${d.retryAfterSeconds}s. For a higher quota, request a free API key at ${c.keyRequestUrl} and send it as "Authorization: Bearer <key>" (or "x-api-key"). Or run the server locally with \`npx -y edgar-entity-mcp\` (no quota; set SEC_USER_AGENT to your own name + email).`
      : `Retry after ${d.retryAfterSeconds}s. Need more? Ask at ${c.keyRequestUrl}, or self-host with \`npx -y edgar-entity-mcp\`.`;
  return new ToolError("RATE_LIMITED", `Rate limit reached: ${d.limit} units per ${per} for ${who}. This call costs ${cost} unit(s).`, hint, {
    retry_after_seconds: d.retryAfterSeconds,
    scope: d.scope,
    limit: d.limit,
    remaining: d.remaining,
    cost,
  });
}

/** A stuck quota backend must not hold requests open; after this long we switch to degraded mode. */
export const QUOTA_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("quota backend timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Charge a tool call to a principal; throws RATE_LIMITED when over quota. If the Redis store fails
 * (unreachable, timeout, plan limit), the server enters degraded mode and enforces the same limits
 * per instance in memory instead of refusing every call. A custom (non-Redis) store that fails
 * still fails closed.
 */
export async function chargeQuota(p: Principal, tool: string, args: unknown, s: QuotaStore = getQuotaStore()): Promise<void> {
  const cost = toolCost(tool, args);
  if (cost <= 0) return;
  const limits = limitsFor(p);
  let d: QuotaDecision;
  const redisBacked = s instanceof UpstashQuotaStore;
  if (redisBacked && redisDegraded()) d = await fallback.consume(p, cost, limits);
  else
    try {
      d = await withTimeout(s.consume(p, cost, limits), QUOTA_TIMEOUT_MS);
    } catch (e) {
      if (!redisBacked) {
        logError("quota", e);
        throw new ToolError("RATE_LIMITED", "Rate limiting is temporarily unavailable, so the call was refused.", "Retry in a few seconds.", { retry_after_seconds: 5, scope: "backend" });
      }
      markRedisDegraded(e);
      d = await fallback.consume(p, cost, limits);
    }
  if (!d.ok) throw rateLimitedError(p, d, cost);
}

/** For tests. */
export function memoryFallbackStore(): MemoryQuotaStore {
  return fallback;
}
