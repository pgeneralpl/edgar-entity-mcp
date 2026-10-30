import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Redis } from "@upstash/redis";
import { config, higherLimitsHint } from "../config.js";
import { ToolError, logError } from "./errors.js";
import { getRedis } from "./cache.js";
import { markRedisDegraded, redisDegraded } from "./degraded.js";
import { currentContext } from "./context.js";
import { statesBeyondWindow } from "../states/socrata.js";
import { SUPPORTED_STATES } from "../states/registry.js";
import { frameTagsFor } from "../sec/metricAliases.js";

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
  /** Soft daily cap shared by ALL anonymous clients; past it each IP still gets `tricklePerDay`. */
  globalPerDay?: number;
  /** Hard daily ceiling for all anonymous clients (soft cap + trickles). */
  globalHardPerDay?: number;
  tricklePerDay?: number;
}

export interface QuotaDecision {
  ok: boolean;
  scope?: "minute" | "day" | "network" | "global";
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
}

/**
 * Daily quota store (fleet-wide with Redis). Per-minute limits are enforced per instance in memory
 * (see chargeQuota) and never cost a Redis command.
 */
export interface QuotaStore {
  consume(p: Principal, cost: number, limits: Limits, now?: number): Promise<QuotaDecision>;
  /** Give back units reserved but not used (actual cost < estimate). Must be cheap / local. */
  refund?(p: Principal, units: number, limits: Limits, now?: number): void;
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
      return 1;
    case "get_xbrl_concept":
      // companyconcept; an unknown / mis-cased tag falls back to companyfacts (large, cached) once
      return 3;
    case "list_filings":
      // tickers + submissions + up to LIST_MAX_HISTORY_PAGES (4) older-history pages
      return a.date_from || a.date_to || num(a.offset, 0) > 0 ? 6 : 1;
    case "get_financials":
      return 2; // companyfacts is a large document
    case "compare_companies":
      // Realistic maximum, reserved up front: one frame request per tag tried (metric mode: ≤ 3
      // fallback tags; tag mode: 1) plus 1 for resolving `companies` (tickers file). Frames are
      // capped at 256 KiB in Redis, so cached reads stay within the same count. Settlement
      // (settleQuota) still refunds what a call did not use, e.g. when a company filter stops early.
      return (typeof a.metric === "string" ? Math.max(1, frameTagsFor(a.metric).length) : 1) + 1;
    case "get_filing_document":
      // url: document + up to 3 redirects; company+accession adds tickers, submissions and up to 4 history pages
      return a.url ? 4 : 10;
    case "get_insider_trades":
      // tickers + submissions + up to 4 history pages + one Form 4 per filing (max 20)
      return 6 + Math.min(Math.max(1, Math.floor(num(a.limit, 10))), 20);
    case "lookup_business_entity": {
      // One registry query per state, plus one count query per state with include_total, plus one
      // unit for any page after the first (discourages bulk enumeration). States whose page is
      // known to be empty (OR past its row window) make no request and are not charged.
      const offset = num(a.offset, 0);
      const states = Array.isArray(a.states) && a.states.length ? [...new Set(a.states.map(String))] : [...SUPPORTED_STATES];
      const st = Math.min(states.length - statesBeyondWindow(states, offset).length, 5);
      if (st <= 0) return 0;
      return (a.include_total === true ? st * 2 : st) + (offset > 0 ? 1 : 0);
    }
    default:
      return 2;
  }
}

export function limitsFor(p: Principal): Limits {
  const q = config().quota;
  if (p.tier === "key") return { perMinute: p.perMinute ?? q.keyPerMinute, perDay: p.perDay ?? q.keyPerDay };
  return {
    perMinute: q.anonPerMinute,
    perDay: q.anonPerDay,
    networkPerDay: q.anonNetworkPerDay,
    globalPerDay: q.anonGlobalPerDay,
    globalHardPerDay: q.anonGlobalHardPerDay,
    tricklePerDay: q.anonTricklePerDay,
  };
}

/** Daily counters live 25 h (the UTC day + 1 h slack for clock skew). Nothing else is stored. */
export const DAY_COUNTER_TTL_SECONDS = 25 * 3600;
/** Per-minute counters are in-memory only (kept 70 s). */
export const MINUTE_COUNTER_TTL_SECONDS = 70;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}
export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

/** One daily counter. Order matters: the caller's own counter first (the trickle rule reads it). */
interface Counter {
  id: string;
  scope: "day" | "network" | "global";
  limit: number;
}

function dayCounters(p: Principal, l: Limits, now: number): Counter[] {
  const day = p.day ?? utcDay(now);
  const counters: Counter[] = [{ id: `q:d:${p.id}:${day}`, scope: "day", limit: l.perDay }];
  if (p.network && l.networkPerDay) counters.push({ id: `q:d:${p.network}:${day}`, scope: "network", limit: l.networkPerDay });
  if (p.tier === "anon" && l.globalPerDay) counters.push({ id: `q:d:anon:${day}`, scope: "global", limit: l.globalPerDay });
  return counters;
}

/**
 * Check counter values *after* applying `deltas`. Returns the index of the first violated counter, or -1.
 * Only counters this call adds to (delta > 0) can be violated. Global cap is soft: past `limit`
 * the call is still allowed while the caller's own counter is within the trickle allowance and the
 * global total is below the hard ceiling. Unknown values (NaN) never cause a violation.
 */
function violation(counters: Counter[], values: number[], deltas: number[], l: Limits): number {
  for (let i = 0; i < counters.length; i++) {
    if (!(deltas[i]! > 0)) continue;
    const c = counters[i]!;
    const v = values[i]!;
    if (Number.isNaN(v)) continue;
    if (c.scope === "global") {
      const own = values[0]!; // unknown own usage: not refused here (the script decides)
      if (v > (l.globalHardPerDay ?? c.limit) || (v > c.limit && !Number.isNaN(own) && own > (l.tricklePerDay ?? 0))) return i;
    } else if (v > c.limit) return i;
  }
  return -1;
}

function blocked(c: Counter, used: number, now: number): QuotaDecision {
  return { ok: false, scope: c.scope, limit: c.limit, remaining: Math.max(0, c.limit - used), retryAfterSeconds: secondsToUtcMidnight(now) };
}

const DAY_MS_TTL = (now: number) => secondsToUtcMidnight(now) * 1000 + 60_000;

/** In-process store (self-hosted HTTP without Redis, degraded mode, and tests). Same semantics as Redis. */
export class MemoryQuotaStore implements QuotaStore {
  private counts = new LRUCache<string, number>({ max: 100_000, ttl: DAY_COUNTER_TTL_SECONDS * 1000 });
  constructor(private now: () => number = Date.now) {}
  async consume(p: Principal, cost: number, l: Limits, at = this.now()): Promise<QuotaDecision> {
    const counters = dayCounters(p, l, at);
    const after = counters.map((c) => (this.counts.get(c.id) ?? 0) + cost);
    const bad = violation(
      counters,
      after,
      counters.map(() => cost),
      l,
    );
    if (bad >= 0) return blocked(counters[bad]!, after[bad]! - cost, at);
    counters.forEach((c, i) => this.counts.set(c.id, after[i]!, { ttl: DAY_MS_TTL(at) }));
    return { ok: true, limit: counters[0]!.limit, remaining: counters[0]!.limit - after[0]! };
  }
  refund(p: Principal, units: number, l: Limits, at = this.now()): void {
    if (units <= 0) return;
    for (const c of dayCounters(p, l, at)) {
      const v = this.counts.get(c.id);
      if (v !== undefined) this.counts.set(c.id, Math.max(0, v - units), { noUpdateTTL: true });
    }
  }
}

/**
 * ONE Lua script per allowed call. Billed Upstash commands = 1 (EVALSHA) + 1 INCRBY per counter
 * whose delta is non-zero (+1 EXPIRE the first time a counter is created each day):
 *   anonymous: 1 + 3 (IP day, /24 day, global anon day) = 4;   API key: 1 + 1 = 2.
 * A refusal inside the script adds 1 DECRBY per counter touched (rollback); refusals are normally
 * answered locally from the memoised counter values, at 0 commands.
 *
 * KEYS = counters. ARGV = [ttl, cost, globalIndex (0 = none), hard, trickle, d1..dn, lim1..limn].
 * d_i = cost - pending refund credit for that counter (can be <= 0). Returns {bad, v1..vn} with
 * values after the call (after rollback if refused); 'u' = not touched (unknown).
 * EXPIRE runs only when INCRBY created the key (v == delta), inside the same atomic script, so a
 * counter can never exist without a TTL.
 */
const QUOTA_SCRIPT = `
local n = #KEYS
local ttl = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local gi = tonumber(ARGV[3])
local hard = tonumber(ARGV[4])
local trickle = tonumber(ARGV[5])
local vals = {}
for i = 1, n do
  local d = tonumber(ARGV[5 + i])
  if d ~= 0 then
    local v = redis.call('INCRBY', KEYS[i], d)
    if v == d then redis.call('EXPIRE', KEYS[i], ttl) end
    vals[i] = v
  else
    vals[i] = 'u'
  end
end
local bad = 0
for i = 1, n do
  local d = tonumber(ARGV[5 + i])
  local lim = tonumber(ARGV[5 + n + i])
  if d > 0 and vals[i] ~= 'u' then
    if i == gi then
      local own = vals[1]
      if vals[i] > hard or (vals[i] > lim and own ~= 'u' and own > trickle) then bad = i break end
    elseif vals[i] > lim then bad = i break end
  end
end
if bad > 0 then
  for i = 1, n do
    if vals[i] ~= 'u' then vals[i] = redis.call('DECRBY', KEYS[i], cost) end
  end
end
local out = {bad}
for i = 1, n do out[i + 1] = vals[i] end -- integers; 'u' (string) = unknown
return out
`;
export const QUOTA_SCRIPT_SHA = createHash("sha1").update(QUOTA_SCRIPT).digest("hex");

/**
 * Redis store.
 * - Memoises the last known value of every counter until UTC midnight. Counters only grow within a
 *   day (except by our own refunds), so a known value is a lower bound: when `cost` would exceed
 *   any counter's remaining allowance the call is refused locally, at 0 Redis commands — for the
 *   caller's own counter, its /24 and the global anonymous budget alike.
 * - Refunds (estimate − actual cost) are kept as local credit per counter and folded into the next
 *   reservation's INCRBY for that counter, so they cost no extra commands.
 */
export class UpstashQuotaStore implements QuotaStore {
  private known = new LRUCache<string, number>({ max: 50_000, ttl: DAY_COUNTER_TTL_SECONDS * 1000 });
  private credit = new LRUCache<string, number>({ max: 50_000, ttl: DAY_COUNTER_TTL_SECONDS * 1000 });
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
  async consume(p: Principal, cost: number, l: Limits, at = this.now()): Promise<QuotaDecision> {
    const counters = dayCounters(p, l, at);
    const deltas = counters.map((c) => cost - (this.credit.get(c.id) ?? 0));
    // Local pre-check against memoised values (lower bounds; already net of local refunds):
    // refused here at 0 Redis commands.
    const projected = counters.map((c) => {
      const k = this.known.get(c.id);
      return k === undefined ? NaN : k + cost;
    });
    const localBad = violation(counters, projected, deltas, l);
    if (localBad >= 0) return blocked(counters[localBad]!, projected[localBad]! - cost, at);

    const gi = counters.findIndex((c) => c.scope === "global") + 1;
    const args = [
      String(DAY_COUNTER_TTL_SECONDS),
      String(cost),
      String(gi),
      String(l.globalHardPerDay ?? 0),
      String(l.tricklePerDay ?? 0),
      ...deltas.map(String),
      ...counters.map((c) => String(c.limit)),
    ];
    const raw = (await this.exec(
      counters.map((c) => this.prefix + c.id),
      args,
    )) as unknown[];
    const bad = Number(raw[0]);
    const vals = counters.map((_, i) => (typeof raw[i + 1] === "number" ? (raw[i + 1] as number) : NaN));
    const ttl = DAY_MS_TTL(at);
    counters.forEach((c, i) => {
      if (Number.isNaN(vals[i]!)) return;
      this.known.set(c.id, vals[i]!, { ttl });
      this.credit.delete(c.id); // credit was applied by this INCRBY
    });
    if (bad > 0) return blocked(counters[bad - 1]!, vals[bad - 1]!, at);
    return { ok: true, limit: counters[0]!.limit, remaining: counters[0]!.limit - (vals[0] ?? 0) };
  }
  refund(p: Principal, units: number, l: Limits, at = this.now()): void {
    if (units <= 0) return;
    for (const c of dayCounters(p, l, at)) {
      this.credit.set(c.id, (this.credit.get(c.id) ?? 0) + units, { ttl: DAY_MS_TTL(at) });
      const k = this.known.get(c.id);
      if (k !== undefined) this.known.set(c.id, k - units, { noUpdateTTL: true });
    }
  }
}

let store: QuotaStore | undefined;
const fallback = new MemoryQuotaStore();
export function getQuotaStore(): QuotaStore {
  if (!store) {
    const redis = getRedis();
    store = redis ? new UpstashQuotaStore(redis) : new MemoryQuotaStore();
  }
  return store;
}
export function setQuotaStore(s: QuotaStore | undefined): void {
  store = s;
}

/** Per-instance per-minute limits (in memory, never Redis). */
const minuteCounts = new LRUCache<string, number>({ max: 100_000, ttl: MINUTE_COUNTER_TTL_SECONDS * 1000 });
function chargeMinute(p: Principal, cost: number, l: Limits, now: number): QuotaDecision {
  const minute = Math.floor(now / 60_000);
  const id = `${p.id}:${minute}`;
  const used = minuteCounts.get(id) ?? 0;
  if (used + cost > l.perMinute)
    return { ok: false, scope: "minute", limit: l.perMinute, remaining: Math.max(0, l.perMinute - used), retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000)) };
  minuteCounts.set(id, used + cost);
  return { ok: true };
}
function refundMinute(p: Principal, units: number, at: number): void {
  const id = `${p.id}:${Math.floor(at / 60_000)}`;
  const used = minuteCounts.get(id);
  if (used !== undefined) minuteCounts.set(id, Math.max(0, used - units), { noUpdateTTL: true });
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
  if (d.scope === "global")
    return new ToolError(
      "RATE_LIMITED",
      `The shared daily budget for anonymous use of this server is spent (${d.limit} units across all anonymous clients), and this IP has used its ${c.quota.anonTricklePerDay}-unit fallback allowance. This call costs ${cost} unit(s).`,
      `Retry after ${d.retryAfterSeconds}s (UTC midnight), or run the server locally from source (https://github.com/pgeneralpl/edgar-entity-mcp). ${higherLimitsHint(c.keyRequestUrl)}`,
      { retry_after_seconds: d.retryAfterSeconds, scope: d.scope, limit: d.limit, cost },
    );
  const hint =
    p.tier === "anon"
      ? `Retry after ${d.retryAfterSeconds}s, or run the server locally from source (https://github.com/pgeneralpl/edgar-entity-mcp) (no quota; set SEC_USER_AGENT to your own name + email). ${higherLimitsHint(c.keyRequestUrl)}`
      : `Retry after ${d.retryAfterSeconds}s, or self-host from source (https://github.com/pgeneralpl/edgar-entity-mcp). ${higherLimitsHint(c.keyRequestUrl)}`;
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

interface Reservation {
  p: Principal;
  cost: number;
  limits: Limits;
  store: QuotaStore;
  at: number;
}

/**
 * Reserve the estimated cost of a tool call (throws RATE_LIMITED when over quota); settleQuota()
 * refunds the difference to the actual cost after the call. If the Redis store fails (unreachable,
 * timeout, plan limit), the server enters degraded mode and enforces the same daily limits per
 * instance in memory. A custom (non-Redis) store that fails still fails closed.
 */
export async function chargeQuota(p: Principal, tool: string, args: unknown, s: QuotaStore = getQuotaStore()): Promise<void> {
  const cost = toolCost(tool, args);
  if (cost <= 0) return;
  const limits = limitsFor(p);
  const at = Date.now();
  const m = chargeMinute(p, cost, limits, at);
  if (!m.ok) throw rateLimitedError(p, m, cost);
  let d: QuotaDecision;
  let used: QuotaStore = s;
  const redisBacked = s instanceof UpstashQuotaStore;
  try {
    if (redisBacked && redisDegraded()) {
      used = fallback;
      d = await fallback.consume(p, cost, limits, at);
    } else
      try {
        d = await withTimeout(s.consume(p, cost, limits, at), QUOTA_TIMEOUT_MS);
      } catch (e) {
        if (!redisBacked) {
          logError("quota", e);
          throw new ToolError("RATE_LIMITED", "Rate limiting is temporarily unavailable, so the call was refused.", "Retry in a few seconds.", { retry_after_seconds: 5, scope: "backend" });
        }
        markRedisDegraded(e);
        used = fallback;
        d = await fallback.consume(p, cost, limits, at);
      }
  } catch (e) {
    refundMinute(p, cost, at);
    throw e;
  }
  if (!d.ok) {
    refundMinute(p, cost, at);
    throw rateLimitedError(p, d, cost);
  }
  const ctx = currentContext();
  if (ctx) ctx.reservation = { p, cost, limits, store: used, at } satisfies Reservation;
}

/** Redis cache bytes read per quota unit (= the max stored value size), so reads are bounded by quota. */
export const REDIS_READ_BYTES_PER_UNIT = 256 * 1024;

/**
 * Settle the reservation of the current call: actual cost = max(upstream requests made, Redis cache
 * bytes read / REDIS_READ_BYTES_PER_UNIT rounded up, 1), capped at the estimate. The rest is refunded.
 * Counting Redis reads keeps a call served from the shared cache from reading many large values for
 * one unit (the Redis plan's monthly bandwidth is the binding limit).
 */
export function settleQuota(): void {
  const ctx = currentContext();
  const r = ctx?.reservation as Reservation | undefined;
  if (!ctx || !r) return;
  ctx.reservation = undefined;
  const actual = ctx.free
    ? 0
    : Math.min(r.cost, Math.max(1, (ctx.upstream ?? 0) + (ctx.surcharge ?? 0), Math.ceil((ctx.redisReadBytes ?? 0) / REDIS_READ_BYTES_PER_UNIT)));
  const back = r.cost - actual;
  if (back <= 0) return;
  r.store.refund?.(r.p, back, r.limits, r.at);
  refundMinute(r.p, back, r.at);
}

/** For tests. */
export function memoryFallbackStore(): MemoryQuotaStore {
  return fallback;
}
/** For tests. */
export function resetMinuteCounters(): void {
  minuteCounts.clear();
}
