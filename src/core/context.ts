import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./quota.js";

/** Per-tool-call context (who is calling), used for upstream budget shares and per-client fetch caps. */
export interface CallContext {
  principal?: Principal;
  transport: "stdio" | "http";
  /** Upstream HTTP requests actually made during this call (cache hits make none). */
  upstream?: number;
  /** Bytes of cache values read from Redis during this call (charged like upstream requests). */
  redisReadBytes?: number;
  /** Quota reservation made before the call, settled (refunded) after it. */
  reservation?: unknown;
}
const als = new AsyncLocalStorage<CallContext>();
export function runWithContext<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
export function currentContext(): CallContext | undefined {
  return als.getStore();
}
/**
 * Keyed callers whose key was confirmed in Redis, and local (stdio) use, may unlock opt-in data such
 * as individual agent details. Keys accepted unverified (degraded mode) count as anonymous here.
 */
export function callerIsTrusted(): boolean {
  const c = als.getStore();
  return !c || c.transport === "stdio" || (c.principal?.tier === "key" && !c.principal.unverified);
}
