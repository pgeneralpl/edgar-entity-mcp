/**
 * Per-call usage hook point.
 *
 * A hosting layer (e.g. a self-hosted deployment) can register hooks for access control,
 * custom quotas, or its own metering and logging:
 *
 *   import { setUsageHooks } from "edgar-entity-mcp";
 *   setUsageHooks({
 *     beforeCall: async (e) => { if (!(await isAllowed(e.apiKey))) throw new Error("Not allowed"); },
 *     afterCall: async (e) => record(e.tool, e.ok, e.ms),
 *   });
 *
 * Throwing a ToolError from beforeCall (e.g. RATE_LIMITED) rejects the call with that error;
 * any other thrown error becomes UNAUTHORIZED.
 */
export interface UsageEvent {
  tool: string;
  transport: "stdio" | "http";
  apiKey?: string;
  clientId?: string;
  /** Rate-limit principal (HTTP): hashed IP or hashed key id, plus tier. */
  principal?: import("./quota.js").Principal;
  /** Tool arguments (used for cost weighting; never logged by the default logger). */
  args?: unknown;
}

export interface UsageResult extends UsageEvent {
  ok: boolean;
  ms: number;
  errorCode?: string;
  /** Approximate response size in characters: the JSON text, counted twice when the same JSON is also sent as structuredContent. */
  responseChars: number;
}

export interface UsageHooks {
  beforeCall?(e: UsageEvent): void | Promise<void>;
  afterCall?(e: UsageResult): void | Promise<void>;
}

let hooks: UsageHooks = {};
/** Built-in hooks (e.g. HTTP quotas) keyed by name; they run before user hooks. */
const systemHooks = new Map<string, UsageHooks>();

export function setUsageHooks(h: UsageHooks): void {
  hooks = h;
}
/** User-registered hooks only. */
export function getUserUsageHooks(): UsageHooks {
  return hooks;
}
export function setSystemUsageHook(name: string, h: UsageHooks | undefined): void {
  if (h) systemHooks.set(name, h);
  else systemHooks.delete(name);
}
/** Effective hooks: system hooks first, then user hooks. */
export function getUsageHooks(): UsageHooks {
  if (!systemHooks.size) return hooks;
  const all = [...systemHooks.values(), hooks];
  return {
    async beforeCall(e) {
      for (const h of all) await h.beforeCall?.(e);
    },
    async afterCall(e) {
      for (const h of all) await h.afterCall?.(e);
    },
  };
}

/** Default hook: structured usage logging to stderr when USAGE_LOG=1. */
export const stderrUsageLogger: UsageHooks = {
  afterCall(e) {
    const { apiKey: _k, args: _a, principal, ...rest } = e;
    process.stderr.write(JSON.stringify({ type: "usage", ts: new Date().toISOString(), principal: principal?.id, tier: principal?.tier, ...rest }) + "\n");
  },
};
