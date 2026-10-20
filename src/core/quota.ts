import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { config } from "../config.js";
import { ToolError, logError } from "./errors.js";
import { getRedis } from "./cache.js";

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
}

export interface Limits {
  perMinute: number;
  perDay: number;
}

export interface QuotaDecision {
  ok: boolean;
  scope?: "minute" | "day";
  limit?: number;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface QuotaStore {
  consume(p: Principal, cost: number, limits: Limits, tool: string): Promise<QuotaDecision>;
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
      return a.date_from || a.date_to || num(a.offset, 0) > 0 ? 3 : 1; // may page through older history
    case "get_financials":
      return 2; // companyfacts is a large document
    case "compare_companies":
      return 3; // frames responses cover every filer
    case "get_filing_document":
      return a.url ? 3 : 4; // up to 15 MB document (+ history lookup for company+accession)
    case "get_insider_trades":
      return 1 + Math.min(Math.max(1, Math.floor(num(a.limit, 10))), 20);
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
  return { perMinute: q.anonPerMinute, perDay: q.anonPerDay };
}

const DAY_TTL: Record<Tier, number> = { anon: 2 * 86400, key: 35 * 86400 };

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}
export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

/** In-process store (self-hosted HTTP without Redis, and tests). */
export class MemoryQuotaStore implements QuotaStore {
  private minute = new Map<string, { window: number; used: number }>();
  private day = new Map<string, number>();
  readonly usage = new Map<string, Record<string, number>>();
  constructor(private now: () => number = Date.now) {}
  async consume(p: Principal, cost: number, l: Limits, tool: string): Promise<QuotaDecision> {
    const t = this.now();
    const w = Math.floor(t / 60_000);
    const m = this.minute.get(p.id);
    const mUsed = m && m.window === w ? m.used : 0;
    if (mUsed + cost > l.perMinute) return { ok: false, scope: "minute", limit: l.perMinute, remaining: Math.max(0, l.perMinute - mUsed), retryAfterSeconds: Math.max(1, Math.ceil(((w + 1) * 60_000 - t) / 1000)) };
    const dk = `${p.id}:${utcDay(t)}`;
    const dUsed = this.day.get(dk) ?? 0;
    if (dUsed + cost > l.perDay) return { ok: false, scope: "day", limit: l.perDay, remaining: Math.max(0, l.perDay - dUsed), retryAfterSeconds: secondsToUtcMidnight(t) };
    this.minute.set(p.id, { window: w, used: mUsed + cost });
    this.day.set(dk, dUsed + cost);
    const u = this.usage.get(dk) ?? {};
    u[tool] = (u[tool] ?? 0) + 1;
    u.units = (u.units ?? 0) + cost;
    this.usage.set(dk, u);
    return { ok: true, limit: l.perDay, remaining: l.perDay - dUsed - cost };
  }
}

/**
 * Atomic daily quota + durable usage counters in ONE Redis command:
 * check used+cost <= limit, INCRBY, set TTL on first use, HINCRBY per-tool calls and units.
 */
const DAY_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + cost > limit then return {0, used} end
local n = redis.call('INCRBY', KEYS[1], cost)
if n == cost then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
redis.call('HINCRBY', KEYS[2], ARGV[4], 1)
local u = redis.call('HINCRBY', KEYS[2], 'units', cost)
if u == cost then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3])) end
return {1, n}
`;

/**
 * Redis store: per-minute window via @upstash/ratelimit (fixed window, cost-weighted via `rate`,
 * ephemeral in-memory cache answers already-blocked clients without a Redis call) + the daily script.
 * Allowed call = 2 Redis commands; blocked-by-minute call = 0–1. Errors fail CLOSED.
 */
export class UpstashQuotaStore implements QuotaStore {
  private minuteLimiters = new Map<number, Ratelimit>();
  private script: ReturnType<Redis["createScript"]>;
  constructor(
    private redis: Redis,
    private prefix = config().cachePrefix,
  ) {
    this.script = redis.createScript(DAY_SCRIPT);
  }
  private minuteLimiter(perMinute: number): Ratelimit {
    let rl = this.minuteLimiters.get(perMinute);
    if (!rl) {
      rl = new Ratelimit({
        redis: this.redis,
        limiter: Ratelimit.fixedWindow(perMinute, "60 s"),
        prefix: `${this.prefix}q:m`,
        timeout: 0,
        analytics: false,
        ephemeralCache: new Map(),
      });
      this.minuteLimiters.set(perMinute, rl);
    }
    return rl;
  }
  async consume(p: Principal, cost: number, l: Limits, tool: string): Promise<QuotaDecision> {
    const m = await this.minuteLimiter(l.perMinute).limit(p.id, { rate: cost });
    if (!m.success || m.reason === "timeout")
      return { ok: false, scope: "minute", limit: l.perMinute, remaining: Math.max(0, m.remaining), retryAfterSeconds: Math.max(1, Math.ceil((m.reset - Date.now()) / 1000)) };
    const day = utcDay();
    const [ok, used] = (await this.script.exec(
      [`${this.prefix}q:d:${p.id}:${day}`, `${this.prefix}u:${p.id}:${day}`],
      [String(cost), String(l.perDay), String(DAY_TTL[p.tier]), tool],
    )) as [number, number];
    if (Number(ok) !== 1) return { ok: false, scope: "day", limit: l.perDay, remaining: Math.max(0, l.perDay - Number(used)), retryAfterSeconds: secondsToUtcMidnight() };
    return { ok: true, limit: l.perDay, remaining: l.perDay - Number(used) };
  }
}

let store: QuotaStore | undefined;
export function getQuotaStore(): QuotaStore {
  if (!store) {
    const r = getRedis();
    store = r ? new UpstashQuotaStore(r) : new MemoryQuotaStore();
  }
  return store;
}
export function setQuotaStore(s: QuotaStore | undefined): void {
  store = s;
}

export function rateLimitedError(p: Principal, d: QuotaDecision, cost: number): ToolError {
  const c = config();
  const who = p.tier === "anon" ? "anonymous clients (per IP)" : "this API key";
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

/** Charge a tool call to a principal; throws RATE_LIMITED when over quota or when the backend is unavailable (fail closed). */
export async function chargeQuota(p: Principal, tool: string, args: unknown, s: QuotaStore = getQuotaStore()): Promise<void> {
  const cost = toolCost(tool, args);
  if (cost <= 0) return;
  let d: QuotaDecision;
  try {
    d = await s.consume(p, cost, limitsFor(p), tool);
  } catch (e) {
    logError("quota", e);
    throw new ToolError("RATE_LIMITED", "Rate limiting is temporarily unavailable, so the call was refused.", "Retry in a few seconds.", { retry_after_seconds: 5, scope: "backend" });
  }
  if (!d.ok) throw rateLimitedError(p, d, cost);
}
