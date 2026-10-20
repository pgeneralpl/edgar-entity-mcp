import { describe, expect, it } from "vitest";
import type { Redis } from "@upstash/redis";
import { UpstashCache } from "../src/core/cache.js";
import { RateLimiter } from "../src/core/rateLimiter.js";

function fakeRedis() {
  const store = new Map<string, { v: string; ex?: number }>();
  const counters = new Map<string, number>();
  const r = {
    store,
    async get(k: string) {
      return store.get(k)?.v ?? null;
    },
    async set(k: string, v: string, opts?: { ex?: number }) {
      store.set(k, { v, ex: opts?.ex });
      return "OK";
    },
    async incr(k: string) {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    },
    async expire() {
      return 1;
    },
  };
  return r;
}

describe("Upstash adapters (fake client)", () => {
  it("stores with TTL and skips oversized values", async () => {
    const r = fakeRedis();
    const c = new UpstashCache(r as unknown as Redis, 10);
    await c.set("a", "small", 60);
    await c.set("b", "this value is too large", 60);
    expect(await c.get("a")).toBe("small");
    expect(await c.get("b")).toBeUndefined();
    expect(r.store.get("a")!.ex).toBe(60);
  });
  it("never throws when Redis fails", async () => {
    const broken = { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } };
    const c = new UpstashCache(broken as unknown as Redis, 1000);
    await expect(c.set("x", "y", 1)).resolves.toBeUndefined();
    await expect(c.get("x")).resolves.toBeUndefined();
  });
  it("distributed limiter waits for a token when the fleet bucket is empty", async () => {
    let calls = 0;
    const bucket = { take: async () => (++calls === 1 ? { ok: false as const, retryAfterMs: 30 } : { ok: true as const }) };
    const rl = new RateLimiter(1000, bucket);
    const t0 = Date.now();
    await rl.acquire();
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
