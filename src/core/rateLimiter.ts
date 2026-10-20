import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { ToolError } from "./errors.js";
import { markRedisDegraded, redisDegraded } from "./degraded.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fleet-wide token source. `take` must throw when the backend is unreachable. */
export interface DistributedBucket {
  take(): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>;
}

/**
 * Atomic token bucket in Upstash Redis (via @upstash/ratelimit's Lua script): 1 token every
 * 1000/rps ms, burst 2, so traffic is spread evenly instead of arriving in 1-second bursts.
 * One EVALSHA per token; while the bucket is empty the library's in-memory ephemeral cache answers
 * "blocked" without touching Redis. `timeout: 0` disables the library's fail-open-on-timeout.
 */
export function upstashTokenBucket(redis: Redis, rps: number, name: string): DistributedBucket {
  const intervalMs = Math.max(20, Math.round(1000 / Math.max(0.1, rps)));
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(1, `${intervalMs} ms`, 2),
    prefix: "eem:rl",
    timeout: 0,
    analytics: false,
    ephemeralCache: new Map(),
  });
  return {
    async take() {
      const r = await rl.limit(name);
      if (r.success && r.reason !== "timeout") return { ok: true };
      return { ok: false, retryAfterMs: Math.max(20, r.reset - Date.now()) };
    },
  };
}

export interface RateLimiterOptions {
  /** Label used in error messages. */
  name?: string;
  /** Give up (RATE_LIMITED) if no fleet token was granted within this time. */
  maxWaitMs?: number;
  /** Max fleet-bucket rounds per acquire (each round that reaches Redis costs one command per bucket tried). */
  maxAttempts?: number;
  /** Refuse new work if the local queue is already this long (prevents pile-ups in one instance). */
  maxQueueMs?: number;
  /** Local-only rate used while Redis is unavailable (degraded mode). */
  degradedRps?: number;
}

export interface FleetBuckets {
  /** Shared by everyone. */
  shared?: DistributedBucket;
  /** Reserved for API-key callers; they use it first and fall back to the shared bucket. */
  reserved?: DistributedBucket;
}

/** Local even spacing at a given rate (no network). */
class Spacer {
  private next = 0;
  constructor(
    private interval: number,
    private maxQueueMs: number,
  ) {}
  /** Returns false when the local queue is too long. */
  async wait(): Promise<number | null> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    if (slot - now > this.maxQueueMs) return slot - now;
    this.next = slot + this.interval;
    if (slot > now) await sleep(slot - now);
    return null;
  }
}

/**
 * Two-stage limiter.
 * 1. Local: evenly spaces calls in this process at `rps` (no network).
 * 2. Fleet-wide token buckets shared by all instances (anonymous callers: shared bucket only;
 *    keyed callers: reserved bucket first, then shared). If no token arrives within maxWaitMs the
 *    call fails with RATE_LIMITED (fail closed). If Redis itself fails, the limiter switches to
 *    degraded mode: a conservative local rate (default 1 rps per instance) instead of an outage.
 */
export class RateLimiter {
  private readonly local: Spacer;
  private readonly degraded: Spacer;
  private readonly o: Required<RateLimiterOptions>;
  private readonly buckets: FleetBuckets;
  constructor(
    readonly rps: number,
    buckets?: DistributedBucket | FleetBuckets,
    opts: RateLimiterOptions = {},
  ) {
    this.o = { name: opts.name ?? "upstream", maxWaitMs: opts.maxWaitMs ?? 5000, maxAttempts: opts.maxAttempts ?? 6, maxQueueMs: opts.maxQueueMs ?? 15_000, degradedRps: opts.degradedRps ?? 1 };
    this.buckets = buckets && "take" in buckets ? { shared: buckets } : (buckets ?? {});
    this.local = new Spacer(1000 / rps, this.o.maxQueueMs);
    this.degraded = new Spacer(1000 / this.o.degradedRps, this.o.maxQueueMs);
  }

  private busy(why: string, retryAfterSeconds = 2): ToolError {
    return new ToolError("RATE_LIMITED", `The server's shared ${this.o.name} request budget is ${why}.`, "Retry in a few seconds.", {
      retry_after_seconds: retryAfterSeconds,
      scope: `${this.o.name.toLowerCase()}_budget`,
    });
  }

  private get distributed(): boolean {
    return !!(this.buckets.shared || this.buckets.reserved);
  }

  async acquire(tier: "anon" | "key" = "anon"): Promise<void> {
    const q = await this.local.wait();
    if (q !== null) throw this.busy("saturated on this instance", Math.ceil(q / 1000));
    if (!this.distributed) return;
    if (redisDegraded()) return this.acquireDegraded();
    try {
      await this.acquireDistributed(tier);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      markRedisDegraded(e);
      return this.acquireDegraded();
    }
  }

  private async acquireDegraded(): Promise<void> {
    const q = await this.degraded.wait();
    if (q !== null) throw this.busy("limited while the shared rate-limit store is unavailable", Math.ceil(q / 1000));
  }

  private async acquireDistributed(tier: "anon" | "key"): Promise<void> {
    const order = [tier === "key" ? this.buckets.reserved : undefined, this.buckets.shared].filter((b): b is DistributedBucket => !!b);
    const deadline = Date.now() + this.o.maxWaitMs;
    for (let i = 0; i < this.o.maxAttempts; i++) {
      let wait = Infinity;
      for (const b of order) {
        const r = await b.take(); // throws -> degraded mode (handled by caller)
        if (r.ok) return;
        wait = Math.min(wait, r.retryAfterMs);
      }
      wait += Math.random() * 30;
      if (Date.now() + wait > deadline) break;
      await sleep(wait);
    }
    throw this.busy("exhausted right now");
  }
}

/**
 * Per-client cap on concurrent upstream fetches (per instance), so one caller's fan-out cannot
 * monopolise the shared budget. Waiters queue; after maxWaitMs they get RATE_LIMITED.
 */
export class ClientSlots {
  private active = new Map<string, number>();
  private waiters = new Map<string, (() => void)[]>();
  constructor(
    private max: number,
    private maxWaitMs = 20_000,
  ) {}
  async run<T>(clientId: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!clientId) return fn();
    if ((this.active.get(clientId) ?? 0) >= this.max) {
      // Wait for a slot to be handed over directly by a finishing call (active count unchanged).
      await new Promise<void>((resolve, reject) => {
        const list = this.waiters.get(clientId) ?? [];
        const timer = setTimeout(() => {
          const l = this.waiters.get(clientId);
          if (l) l.splice(l.indexOf(go), 1);
          if (l && !l.length) this.waiters.delete(clientId);
          reject(new ToolError("RATE_LIMITED", "Too many concurrent upstream requests from this client.", "Make fewer parallel calls.", { retry_after_seconds: 5, scope: "client_concurrency" }));
        }, this.maxWaitMs);
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        list.push(go);
        this.waiters.set(clientId, list);
      });
    } else this.active.set(clientId, (this.active.get(clientId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const next = this.waiters.get(clientId)?.shift();
      if (!this.waiters.get(clientId)?.length) this.waiters.delete(clientId);
      if (next) next(); // hand this slot to the next waiter
      else {
        const n = (this.active.get(clientId) ?? 1) - 1;
        if (n <= 0) this.active.delete(clientId);
        else this.active.set(clientId, n);
      }
    }
  }
  activeFor(clientId: string): number {
    return this.active.get(clientId) ?? 0;
  }
}
