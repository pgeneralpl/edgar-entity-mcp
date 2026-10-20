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

export function markRedisDegraded(why: unknown): void {
  const now = Date.now();
  if (now >= until) {
    since = now;
    lastReason = /max requests limit/i.test(String(why)) ? "redis plan limit reached" : "redis unavailable";
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
