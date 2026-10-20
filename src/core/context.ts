import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./quota.js";

/** Per-tool-call context (who is calling), used for upstream budget shares and per-client fetch caps. */
export interface CallContext {
  principal?: Principal;
  transport: "stdio" | "http";
}
const als = new AsyncLocalStorage<CallContext>();
export function runWithContext<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
export function currentContext(): CallContext | undefined {
  return als.getStore();
}
/** Keyed callers, and local (stdio) use, may unlock opt-in data such as individual agent details. */
export function callerIsTrusted(): boolean {
  const c = als.getStore();
  return !c || c.transport === "stdio" || c.principal?.tier === "key";
}
