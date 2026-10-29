import { describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";
import { UpstashCache, redisCacheKey } from "../src/core/cache.js";
import { RateLimiter } from "../src/core/rateLimiter.js";

describe("Upstash adapters (fake client)", () => {
  it("stores with TTL and skips oversized values", async () => {
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fetchStub);
    const c = new UpstashCache(new Redis({ url: FAKE, token: "t", automaticDeserialization: false }), 10);
    await c.set("a", "small", 60);
    await c.set("b", "this value is too large", 60);
    expect(await c.get("a")).toBe("small");
    expect(await c.get("b")).toBeUndefined();
    expect(f.kv.get(redisCacheKey("a"))!.ttl).toBe(60);
    vi.unstubAllGlobals();
  });
  it("hashes cache keys so Redis never sees upstream URLs / tool arguments", async () => {
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fetchStub);
    const c = new UpstashCache(new Redis({ url: FAKE, token: "t", automaticDeserialization: false }), 1000);
    await c.set("eem:v1:https://data.colorado.gov/resource/x.json?$where=entityname like '%JANE DOE%'", "[]", 60);
    const keys = [...f.kv.keys()].filter((k) => !k.includes(":cw:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^eem:v1:c:[0-9a-f]{40}$/);
    expect(keys[0]).not.toMatch(/JANE|colorado/i);
    vi.unstubAllGlobals();
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
