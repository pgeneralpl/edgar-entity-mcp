import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { ToolError } from "./errors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fleet-wide token source. `take` must throw when the backend is unreachable. */
export interface DistributedBucket {
  take(): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>;
}

/**
 * Atomic token bucket in Upstash Redis (via @upstash/ratelimit's Lua script).
 * One EVALSHA per token; while the bucket is empty, the library's in-memory
 * ephemeral cache answers "blocked" without touching Redis until the next refill.
 * `timeout: 0` disables the library's fail-open-on-timeout behaviour.
 */
export function upstashTokenBucket(redis: Redis, rps: number, name: string): DistributedBucket {
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(Math.max(1, Math.floor(rps)), "1 s", Math.max(1, Math.floor(rps))),
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
  /** Give up (RATE_LIMITED) if the fleet bucket has not granted a token within this time. */
  maxWaitMs?: number;
  /** Max fleet-bucket attempts per acquire (each attempt that reaches Redis costs one command). */
  maxAttempts?: number;
  /** Refuse new work if the local queue is already this long (prevents pile-ups in one instance). */
  maxQueueMs?: number;
}

/**
 * Two-stage limiter.
 * 1. Local: evenly spaces calls in this process at `rps` (no network).
 * 2. Optional fleet-wide token bucket shared by all instances. Fails CLOSED: if the
 *    backend errors, or no token is granted within maxWaitMs / maxAttempts, acquire()
 *    throws RATE_LIMITED instead of letting the request through.
 */
export class RateLimiter {
  private next = 0;
  private readonly interval: number;
  private readonly o: Required<RateLimiterOptions>;
  constructor(
    readonly rps: number,
    private readonly bucket?: DistributedBucket,
    opts: RateLimiterOptions = {},
  ) {
    this.interval = 1000 / rps;
    this.o = { name: opts.name ?? "upstream", maxWaitMs: opts.maxWaitMs ?? 5000, maxAttempts: opts.maxAttempts ?? 4, maxQueueMs: opts.maxQueueMs ?? 15_000 };
  }

  private busy(why: string, retryAfterSeconds = 2): ToolError {
    return new ToolError("RATE_LIMITED", `The server's shared ${this.o.name} request budget is ${why}.`, "Retry in a few seconds.", {
      retry_after_seconds: retryAfterSeconds,
      scope: `${this.o.name.toLowerCase()}_budget`,
    });
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    if (slot - now > this.o.maxQueueMs) throw this.busy("saturated on this instance", Math.ceil((slot - now) / 1000));
    this.next = slot + this.interval;
    if (slot > now) await sleep(slot - now);
    if (this.bucket) await this.acquireDistributed();
  }

  private async acquireDistributed(): Promise<void> {
    const deadline = Date.now() + this.o.maxWaitMs;
    for (let i = 0; i < this.o.maxAttempts; i++) {
      let r: Awaited<ReturnType<DistributedBucket["take"]>>;
      try {
        r = await this.bucket!.take();
      } catch {
        throw this.busy("temporarily unavailable (rate-limit backend unreachable)", 5);
      }
      if (r.ok) return;
      const wait = r.retryAfterMs + Math.random() * 40;
      if (Date.now() + wait > deadline) break;
      await sleep(wait);
    }
    throw this.busy("exhausted right now");
  }
}
