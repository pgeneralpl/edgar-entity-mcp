import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { getRedis } from "../core/cache.js";
import { ToolError, logError } from "../core/errors.js";
import { markRedisDegraded, redisDegraded } from "../core/degraded.js";
import { BUILTIN_SUPPRESSIONS } from "./suppression-list.js";
import type { AgentInfo, NormalizedEntity } from "./registry.js";

export interface Suppression {
  entities: Set<string>;
  agentNames: Set<string>;
}

export const normName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
/** Entity ids are compared case-insensitively, without punctuation/whitespace or leading zeros. */
export const normEntityId = (state: string, id: string) => `${state.toUpperCase()}:${id.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=.)/, "")}`;

export function parseSuppressions(entries: Iterable<string>): Suppression {
  const out: Suppression = { entities: new Set(), agentNames: new Set() };
  for (const raw of entries) {
    const e = String(raw).trim();
    const m = /^entity:([A-Z]{2}):(.+)$/i.exec(e);
    if (m) out.entities.add(normEntityId(m[1]!, m[2]!.trim()));
    else if (/^agent:/i.test(e)) {
      const n = normName(e.slice(6));
      if (n) out.agentNames.add(n);
    }
  }
  return out;
}

export function suppressionKey(): string {
  return `${config().cachePrefix}suppress`;
}

const REFRESH_MS = 10 * 60 * 1000;
let cache: { at: number; value: Suppression } | undefined;

/**
 * Load built-in + file + Redis suppressions (Redis read at most every 10 minutes per instance).
 * If Redis is configured but the list has never been loaded on this instance (cold start) and Redis
 * fails, state lookups are refused rather than served with the built-in list only: an erasure
 * request recorded in Redis must never be bypassed. After one good load, the last good list is kept.
 */
export async function loadSuppression(): Promise<Suppression> {
  if (cache && Date.now() - cache.at < REFRESH_MS) return cache.value;
  const entries: string[] = [...BUILTIN_SUPPRESSIONS];
  const file = config().suppressionFile;
  if (file) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(j)) entries.push(...j.map(String));
    } catch (e) {
      logError("suppression-file", e);
    }
  }
  const redis = getRedis();
  if (redis) {
    const unavailable = () =>
      new ToolError("UPSTREAM_ERROR", "State registry lookups are temporarily unavailable (the privacy suppression list could not be loaded).", "Retry in a minute.", { retry_after_seconds: 60 });
    if (redisDegraded()) {
      if (cache) return cache.value;
      throw unavailable();
    }
    try {
      entries.push(...((await redis.smembers(suppressionKey())) as string[]));
    } catch (e) {
      markRedisDegraded(e);
      logError("suppression-redis", e);
      if (cache) return cache.value; // keep the last good list
      throw unavailable();
    }
  }
  cache = { at: Date.now(), value: parseSuppressions(entries) };
  return cache.value;
}

export function resetSuppressionCache(v?: Suppression): void {
  cache = v ? { at: Date.now(), value: v } : undefined;
}

const WITHHELD: AgentInfo = { kind: "individual", withheld: true };

/** Whole-word containment on normalized names ("JANE DOE" in "C/O JANE DOE, 1 MAIN ST"). */
function containsName(hay: string | undefined, names: Set<string>): boolean {
  if (!hay || !names.size) return false;
  const h = ` ${normName(hay)} `;
  for (const n of names) if (h.includes(` ${n} `)) return true;
  return false;
}

/**
 * Apply privacy rules to normalized entities:
 * - suppressed entities (by normalized id), and entities whose name, NY location name or any
 *   address contains a suppressed person's name, lose every personal field;
 * - suppressed agent names are always withheld;
 * - individual (natural-person) agents are withheld unless includeAgentDetails (keyed callers only);
 * - when an agent / service-of-process contact is an individual, the entity's principal/mailing
 *   addresses and NY location name are withheld too (for one-person businesses these are often a
 *   home address), unless includeAgentDetails.
 */
export function applyPrivacy(entities: NormalizedEntity[], o: { includeAgentDetails: boolean; suppression: Suppression }): NormalizedEntity[] {
  const names = o.suppression.agentNames;
  const fix = (a: AgentInfo | undefined): AgentInfo | undefined => {
    if (!a) return a;
    if (containsName(a.name, names) || containsName(a.address, names)) return { withheld: true, kind: a.kind };
    if (a.kind !== "organization" && !o.includeAgentDetails) return WITHHELD;
    return a;
  };
  return entities.map((e) => {
    const personalHit = [e.name, e.location_name, e.principal_address, e.mailing_address].some((f) => containsName(f, names));
    if (o.suppression.entities.has(normEntityId(e.state, e.entity_id)) || personalHit) {
      const { registered_agent: _a, service_of_process: _s, principal_address: _p, mailing_address: _m, location_name: _l, ...rest } = e;
      return { ...rest, redacted: "Personal data removed following a data-subject request." };
    }
    const out = { ...e };
    if (e.registered_agent) out.registered_agent = fix(e.registered_agent);
    if (e.service_of_process) out.service_of_process = fix(e.service_of_process);
    const individualParty = [e.registered_agent, e.service_of_process].some((a) => a && a.kind !== "organization");
    const suppressedParty = [out.registered_agent, out.service_of_process].some((a) => a?.withheld && a.kind === "organization");
    if ((individualParty && !o.includeAgentDetails) || suppressedParty) {
      const had = e.principal_address || e.mailing_address || e.location_name;
      delete out.principal_address;
      delete out.mailing_address;
      delete out.location_name;
      if (had) out.addresses_withheld = true;
    }
    return out;
  });
}
