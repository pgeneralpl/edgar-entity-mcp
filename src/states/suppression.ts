import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { getRedis } from "../core/cache.js";
import { logError } from "../core/errors.js";
import { BUILTIN_SUPPRESSIONS } from "./suppression-list.js";
import type { AgentInfo, NormalizedEntity } from "./registry.js";

export interface Suppression {
  entities: Set<string>;
  agentNames: Set<string>;
}

export const normName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

export function parseSuppressions(entries: Iterable<string>): Suppression {
  const out: Suppression = { entities: new Set(), agentNames: new Set() };
  for (const raw of entries) {
    const e = String(raw).trim();
    const m = /^entity:([A-Z]{2}):(.+)$/i.exec(e);
    if (m) out.entities.add(`${m[1]!.toUpperCase()}:${m[2]!.trim()}`);
    else if (/^agent:/i.test(e)) out.agentNames.add(normName(e.slice(6)));
  }
  return out;
}

export function suppressionKey(): string {
  return `${config().cachePrefix}suppress`;
}

const REFRESH_MS = 10 * 60 * 1000;
let cache: { at: number; value: Suppression } | undefined;

/** Load built-in + file + Redis suppressions (Redis read at most every 10 minutes per instance). */
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
    try {
      entries.push(...((await redis.smembers(suppressionKey())) as string[]));
    } catch (e) {
      logError("suppression-redis", e);
      if (cache) return cache.value; // keep the last good list
    }
  }
  cache = { at: Date.now(), value: parseSuppressions(entries) };
  return cache.value;
}

export function resetSuppressionCache(v?: Suppression): void {
  cache = v ? { at: Date.now(), value: v } : undefined;
}

const WITHHELD: AgentInfo = { kind: "individual", withheld: true };

/**
 * Apply privacy rules to normalized entities:
 * - individual (natural-person) agents are withheld unless includeAgentDetails;
 * - suppressed agent names are always withheld;
 * - suppressed entities lose agent/service-of-process/address fields.
 */
export function applyPrivacy(entities: NormalizedEntity[], o: { includeAgentDetails: boolean; suppression: Suppression }): NormalizedEntity[] {
  const fix = (a: AgentInfo | undefined): AgentInfo | undefined => {
    if (!a) return a;
    if (a.name && o.suppression.agentNames.has(normName(a.name))) return { withheld: true, kind: a.kind };
    if (a.kind !== "organization" && !o.includeAgentDetails) return WITHHELD;
    return a;
  };
  return entities.map((e) => {
    if (o.suppression.entities.has(`${e.state}:${e.entity_id}`)) {
      const { registered_agent: _a, service_of_process: _s, principal_address: _p, mailing_address: _m, ...rest } = e;
      return { ...rest, redacted: "Personal data removed following a data-subject request." };
    }
    const out = { ...e };
    if (e.registered_agent) out.registered_agent = fix(e.registered_agent);
    if (e.service_of_process) out.service_of_process = fix(e.service_of_process);
    return out;
  });
}
