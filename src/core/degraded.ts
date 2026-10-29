import { logError } from "./errors.js";

/**
 * Degraded mode: when Redis is unreachable or its plan quota is exhausted, the server keeps serving
 * with per-instance in-memory quotas; anonymous callers are served from cache only and API-key
 * callers at a conservative local SEC rate (DEGRADED_SEC_RPS, default 0.2/s), instead of
 * a hard outage. Redis is retried after a cool-down (one attempt per cool-down period).
 */
export const DEGRADED_COOLDOWN_MS = 60_000;
let until = 0;
let since = 0;
let lastReason = "";

/**
 * Upstash with eviction off rejects writes once the database is at its data-size limit
 * ("ERR DB capacity quota exceeded"); self-hosted Redis says "OOM command not allowed when used
 * memory > 'maxmemory'". Deliberately narrow: request/bandwidth plan limits are a different error.
 */
const CAPACITY_RE = /DB capacity quota exceeded|OOM command not allowed|used memory > 'maxmemory'|max(?:imum)? data size (?:limit )?(?:exceeded|reached)/i;
export function isRedisCapacityError(why: unknown): boolean {
  return CAPACITY_RE.test(why instanceof Error ? why.message : String(why));
}
export function redisErrorReason(why: unknown): string {
  if (isRedisCapacityError(why)) return "redis full";
  return /max requests limit/i.test(String(why)) ? "redis plan limit reached" : "redis unavailable";
}

export function markRedisDegraded(why: unknown): void {
  const now = Date.now();
  if (now >= until) {
    since = now;
    lastReason = redisErrorReason(why);
    logError("redis-degraded", why);
  }
  until = now + DEGRADED_COOLDOWN_MS;
}
export function redisDegraded(): boolean {
  return Date.now() < until;
}
export function clearRedisDegraded(): void {
  until = 0;
}
export function degradedStatus(): { degraded: boolean; reason?: string; since?: string } {
  return redisDegraded() ? { degraded: true, reason: lastReason, since: new Date(since).toISOString() } : { degraded: false };
}
