import { getJson } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { STATE_SOURCES, type NormalizedEntity, type StateSource } from "./registry.js";
import { coreTokens, dice } from "../sec/tickers.js";
import { applyPrivacy, loadSuppression, type Suppression } from "./suppression.js";
import { stripInvisible } from "../core/untrusted.js";

export type MatchMode = "contains" | "starts_with" | "exact";

/** Escape a value for a SoQL string literal and strip LIKE wildcards. */
export function soqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function cleanNameQuery(q: string): string {
  return q
    .replace(/[%_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function buildWhere(src: StateSource, opts: { name?: string; entityId?: string; mode: MatchMode; activeOnly?: boolean }): string {
  const clauses: string[] = [];
  if (opts.activeOnly && src.activeWhere) clauses.push(src.activeWhere);
  if (opts.entityId) clauses.push(`${src.idField} = ${soqlString(opts.entityId.trim())}`);
  if (opts.name) {
    const q = cleanNameQuery(opts.name);
    const f = `upper(${src.nameField})`;
    if (opts.mode === "exact") clauses.push(`${f} = ${soqlString(q)}`);
    else if (opts.mode === "starts_with") clauses.push(`starts_with(${f}, ${soqlString(q)})`);
    else clauses.push(`${f} like ${soqlString(`%${q}%`)}`);
  }
  return clauses.join(" AND ");
}

export function buildQueryUrl(src: StateSource, where: string, limit: number): string {
  const p = new URLSearchParams();
  p.set("$where", where);
  if (src.select) p.set("$select", src.select.join(","));
  if (src.group && src.select) p.set("$group", src.select.join(","));
  p.set("$limit", String(limit));
  return `https://${src.domain}/resource/${src.dataset}.json?${p.toString()}`;
}

export function rowSourceUrl(src: StateSource, id: string): string {
  return `https://${src.domain}/resource/${src.dataset}.json?${encodeURIComponent(src.idField)}=${encodeURIComponent(id)}`;
}

/** Rank by similarity to the query: exact > prefix > others (then shorter names first). */
export function rankEntities(rows: NormalizedEntity[], query?: string): NormalizedEntity[] {
  if (!query) return rows;
  const q = coreTokens(query).join(" ");
  const score = (e: NormalizedEntity) => {
    const n = coreTokens(e.name).join(" ");
    if (n === q) return 3;
    if (n.startsWith(q)) return 2 + dice(q, n) / 10;
    return 1 + dice(q, n);
  };
  return [...rows].map((e) => ({ e, sc: score(e) })).sort((a, b) => b.sc - a.sc || a.e.name.length - b.e.name.length).map((x) => x.e);
}

export async function searchState(
  code: string,
  opts: { name?: string; entityId?: string; mode: MatchMode; limit: number; activeOnly?: boolean; includeAgentDetails?: boolean; suppression?: Suppression },
): Promise<{ entities: NormalizedEntity[]; query_url: string }> {
  const src = STATE_SOURCES[code];
  if (!src) throw new ToolError("UNSUPPORTED", `State ${code} is not supported.`);
  // Load the suppression list BEFORE any upstream request: refuse (cold start, Redis down) early.
  const suppression = opts.suppression ?? (await loadSuppression());
  const where = buildWhere(src, opts);
  if (!where) throw new ToolError("INVALID_INPUT", "Provide name or entity_id.");
  // Modest over-fetch so we can rank, and to group multi-row datasets.
  const fetchN = Math.min(200, Math.max(opts.limit * 2, 10) * (src.multiRow ? (src.rowsPerEntity ?? 4) : 1));
  const url = buildQueryUrl(src, where, fetchN);
  const rows = await getJson<Record<string, unknown>[]>(url, "socrata", TTL.stateSearch);
  if (!Array.isArray(rows)) throw new ToolError("UPSTREAM_ERROR", `Unexpected response from ${src.domain}`);
  const ranked = rankEntities(src.normalize(rows, (id) => rowSourceUrl(src, id)), opts.name).slice(0, opts.limit);
  const entities = applyPrivacy(ranked.map(cleanEntityText), { includeAgentDetails: !!opts.includeAgentDetails, suppression });
  return { entities, query_url: url };
}

/** Registry text is third-party input: strip invisible/bidi/tag characters from free-text fields. */
function cleanEntityText(e: NormalizedEntity): NormalizedEntity {
  const c = (v: string | undefined) => (v === undefined ? v : stripInvisible(v));
  const ag = (a: NormalizedEntity["registered_agent"]) => (a ? { ...a, name: c(a.name), address: c(a.address) } : a);
  return {
    ...e,
    name: c(e.name)!,
    location_name: c(e.location_name),
    principal_address: c(e.principal_address),
    mailing_address: c(e.mailing_address),
    registered_agent: ag(e.registered_agent),
    service_of_process: ag(e.service_of_process),
  };
}
