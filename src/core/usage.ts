/**
 * Usage / monetization hook point.
 *
 * Nothing is billed today. A hosting layer (e.g. the Vercel deployment) can register
 * hooks to enforce API keys, quotas, or pay-per-call metering:
 *
 *   import { setUsageHooks } from "edgar-entity-mcp";
 *   setUsageHooks({
 *     beforeCall: async (e) => { if (!(await hasCredits(e.apiKey))) throw new Error("Out of credits"); },
 *     afterCall: async (e) => meter(e.apiKey, e.tool, e.ok),
 *   });
 *
 * Throwing from beforeCall rejects the tool call with an UNAUTHORIZED error that is
 * returned to the agent.
 */
export interface UsageEvent {
  tool: string;
  transport: "stdio" | "http";
  apiKey?: string;
  clientId?: string;
}

export interface UsageResult extends UsageEvent {
  ok: boolean;
  ms: number;
  errorCode?: string;
  /** Approximate response size; handy for per-token pricing. */
  responseChars: number;
}

export interface UsageHooks {
  beforeCall?(e: UsageEvent): void | Promise<void>;
  afterCall?(e: UsageResult): void | Promise<void>;
}

let hooks: UsageHooks = {};

export function setUsageHooks(h: UsageHooks): void {
  hooks = h;
}
export function getUsageHooks(): UsageHooks {
  return hooks;
}

/** Default hook: structured usage logging to stderr when USAGE_LOG=1. */
export const stderrUsageLogger: UsageHooks = {
  afterCall(e) {
    const { apiKey, ...rest } = e;
    process.stderr.write(JSON.stringify({ type: "usage", ts: new Date().toISOString(), key: apiKey ? apiKey.slice(0, 6) + "…" : undefined, ...rest }) + "\n");
  },
};
