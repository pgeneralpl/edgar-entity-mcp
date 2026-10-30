import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./quota.js";
import { config } from "../config.js";

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
  /** Units charged on top of the upstream requests (e.g. +1 for registry pages after the first). */
  surcharge?: number;
  /** Refund the whole reservation (call rejected before any upstream work). */
  free?: boolean;
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

/** Anonymous (keyless) caller of the HTTP endpoint, i.e. the hosted server's public tier. */
export function callerIsAnonymous(): boolean {
  const c = als.getStore();
  return !!c && c.transport === "http" && c.principal?.tier !== "key";
}

/**
 * Natural-person registered-agent names/addresses (include_agent_details) are never returned by the hosted
 * endpoint (Vercel), whatever API key is sent. They are available only:
 * - in local stdio use, and
 * - on a self-hosted HTTP server whose operator set ALLOW_PERSON_AGENT_DETAILS=1, to verified API-key callers.
 */
export function personAgentDetailsAllowed(): boolean {
  const cfg = config();
  if (cfg.onVercel) return false;
  const c = als.getStore();
  if (!c || c.transport === "stdio") return true;
  return cfg.allowPersonAgentDetails && callerIsTrusted();
}
