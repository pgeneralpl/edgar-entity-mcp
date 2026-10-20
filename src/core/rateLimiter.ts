import type { Redis } from "@upstash/redis";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Evenly spaces calls so that no more than `rps` start per second in this process.
 * Optionally also enforces a fleet-wide per-second budget via a Redis counter
 * (useful on serverless where many instances share one egress budget).
 */
export class RateLimiter {
  private next = 0;
  private readonly interval: number;
  constructor(
    readonly rps: number,
    private readonly redis?: Redis,
    private readonly redisKey = "rl:sec",
  ) {
    this.interval = 1000 / rps;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.interval;
    if (slot > now) await sleep(slot - now);
    if (this.redis) await this.acquireDistributed();
  }

  private async acquireDistributed(): Promise<void> {
    if (!this.redis) return;
    for (let i = 0; i < 20; i++) {
      const sec = Math.floor(Date.now() / 1000);
      const key = `${this.redisKey}:${sec}`;
      try {
        const n = await this.redis.incr(key);
        if (n === 1) void this.redis.expire(key, 3).catch(() => {});
        if (n <= Math.floor(this.rps)) return;
      } catch {
        return; // Redis unavailable: fall back to local limiting only.
      }
      const wait = (sec + 1) * 1000 - Date.now() + Math.random() * 50;
      await sleep(Math.max(5, wait));
    }
  }
}
