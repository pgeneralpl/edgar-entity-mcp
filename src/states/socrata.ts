import { getJson } from "../core/http.js";
import { TTL } from "../core/cache.js";
import { ToolError } from "../core/errors.js";
import { STATE_SOURCES, type NormalizedEntity, type StateSource } from "./registry.js";
import { canonicalName, coreTokens, dice, isNoiseToken, nameTokens, normalizeName } from "../core/names.js";
import { applyPrivacy, loadSuppression, type Suppression } from "./suppression.js";
import { stripInvisible } from "../core/untrusted.js";

export type MatchMode = "contains" | "starts_with" | "exact";

/** Largest supported pagination offset (per state). */
export const MAX_OFFSET = 500;
/** Row window for multi-row datasets (OR): pagination there is computed over at most this many rows. */
export const MULTIROW_WINDOW = 300;
/** Max spelling variants used for exact matching / ranking (bounds URL length). */
export const MAX_VARIANTS = 32;
/** Max tokens used in a LIKE pattern. */
const MAX_PATTERN_TOKENS = 8;

/** Escape a value for a SoQL string literal. */
export function soqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Upper-case, collapse whitespace and drop LIKE wildcards. */
export function cleanNameQuery(q: string): string {
  return q
    .replace(/[%_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Spellings of legal-form words and "and" that registries use interchangeably. */
const TOKEN_VARIANTS: Record<string, string[]> = {
  AND: ["AND", "&"],
  INC: ["INC", "INC.", "INCORPORATED"],
  INCORPORATED: ["INCORPORATED", "INC", "INC."],
  CORP: ["CORP", "CORP.", "CORPORATION"],
  CORPORATION: ["CORPORATION", "CORP", "CORP."],
  CO: ["CO", "CO.", "COMPANY"],
  COMPANY: ["COMPANY", "CO", "CO."],
  LTD: ["LTD", "LTD.", "LIMITED"],
  LIMITED: ["LIMITED", "LTD", "LTD."],
  LLC: ["LLC", "L.L.C."],
  LP: ["LP", "L.P."],
  LLP: ["LLP", "L.L.P."],
};
const LEGAL_SUFFIXES = new Set(["INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "LLC", "LP", "LLP"]);
/** Suffixes registries commonly write after a comma ("ACME, INC."). */
const COMMA_SUFFIXES = new Set(["INC", "INCORPORATED", "CORP", "CORPORATION", "LTD", "LIMITED", "LLC", "LP", "LLP"]);

/** Suffixes tried for ranking when the query has none ("Nike" ranks "NIKE, INC." as exact). */
const RANK_SUFFIXES = ["INC", "INC.", "CORP", "CORPORATION", "CO", "COMPANY", "LLC", "LTD"];

function expand(tokens: string[], cap: number): string[] {
  let acc: string[] = [""];
  for (const tok of tokens) {
    const alts = TOKEN_VARIANTS[tok] ?? [tok];
    const next: string[] = [];
    for (const a of acc) for (const v of alts) if (next.length < cap) next.push(a ? `${a} ${v}` : v);
    acc = next;
  }
  return acc;
}

/**
 * Upper-case spellings a registry may store for this name: the query as typed, then
 * &/AND and INC/INC./INCORPORATED-style variants, with and without a comma before the final
 * legal suffix and with/without a leading "THE". With `addSuffixes` (ranking only) and a query
 * without a legal suffix, common suffixes are appended too. Bounded to MAX_VARIANTS.
 */
export function nameVariants(name: string, opts: { addSuffixes?: boolean } = {}): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (out.size < MAX_VARIANTS) out.add(v);
  };
  const typed = cleanNameQuery(name);
  if (typed) add(typed);
  // Collapsed tokens so "L.L.C." becomes the LLC key.
  const t0 = normalizeName(name).split(" ").filter(Boolean);
  if (!t0.length) return [...out];
  const bare = t0[0] === "THE" && t0.length > 1 ? t0.slice(1) : t0;
  const hasSuffix = bare.length > 1 && LEGAL_SUFFIXES.has(bare[bare.length - 1]!);
  const bases: string[][] = [bare];
  if (opts.addSuffixes && !hasSuffix) for (const sfx of RANK_SUFFIXES) bases.push([...bare, sfx]);
  bases.push(["THE", ...bare]);
  for (const base of bases) {
    const n = base.length;
    const commaOk = n > 1 && COMMA_SUFFIXES.has(base[n - 1]!) && base[n - 2] !== "AND";
    for (const v of expand(base, MAX_VARIANTS)) {
      add(v);
      if (commaOk) {
        const i = v.lastIndexOf(" ");
        add(`${v.slice(0, i)},${v.slice(i)}`);
      }
    }
  }
  return [...out];
}

/** Distinctive tokens for a LIKE pattern: A-Z/0-9 only (no quotes or wildcards), legal suffixes and AND dropped. */
export function patternTokens(name: string): string[] {
  const t = nameTokens(name);
  const core = t.filter((w) => !isNoiseToken(w));
  return (core.length ? core : t).slice(0, MAX_PATTERN_TOKENS);
}

function nameClause(src: StateSource, name: string, mode: MatchMode): string {
  const f = `upper(${src.nameField})`;
  if (mode === "exact") return `${f} in (${nameVariants(name).map(soqlString).join(", ")})`;
  const tokens = patternTokens(name);
  if (!tokens.length) throw new ToolError("INVALID_INPUT", "name must contain letters or digits.");
  // Tokens in order with anything between them: "Tiffany and Company" -> TIFFANY% (matches "TIFFANY & CO.").
  const body = tokens.join("%");
  return `${f} like ${soqlString(mode === "starts_with" ? `${body}%` : `%${body}%`)}`;
}

export function buildWhere(src: StateSource, opts: { name?: string; entityId?: string; mode: MatchMode; activeOnly?: boolean }): string {
  const clauses: string[] = [];
  if (opts.activeOnly && src.activeWhere) clauses.push(src.activeWhere);
  if (opts.entityId) clauses.push(`${src.idField} = ${soqlString(opts.entityId.trim())}`);
  if (opts.name) clauses.push(nameClause(src, opts.name, opts.mode));
  return clauses.join(" AND ");
}

/**
 * Server-side relevance order: exact (any spelling variant) > prefix > other matches, then
 * active before inactive (datasets with a status), then name and id for a stable page order.
 */
export function buildOrder(src: StateSource, name?: string): string {
  const f = `upper(${src.nameField})`;
  const parts: string[] = [];
  if (name) {
    const tokens = patternTokens(name);
    const prefix = tokens.length ? `, ${f} like ${soqlString(`${tokens.join("%")}%`)}, 1` : "";
    parts.push(`case(${f} in (${nameVariants(name, { addSuffixes: true }).map(soqlString).join(", ")}), 0${prefix}, true, 2)`);
  }
  if (src.activeWhere) parts.push(`case(${src.activeWhere}, 0, true, 1)`);
  parts.push(src.nameField, src.idField);
  return parts.join(", ");
}

export function buildQueryUrl(src: StateSource, where: string, limit: number, opts: { order?: string; offset?: number } = {}): string {
  const p = new URLSearchParams();
  p.set("$where", where);
  if (src.select) p.set("$select", src.select.join(","));
  if (src.group && src.select) p.set("$group", src.select.join(","));
  if (opts.order) p.set("$order", opts.order);
  p.set("$limit", String(limit));
  if (opts.offset) p.set("$offset", String(opts.offset));
  return `https://${src.domain}/resource/${src.dataset}.json?${p.toString()}`;
}

/** Count matching entities (distinct ids for row-per-person or grouped datasets). */
export function buildCountUrl(src: StateSource, where: string): string {
  const p = new URLSearchParams();
  p.set("$select", src.multiRow || src.group ? `count(distinct ${src.idField}) as n` : "count(*) as n");
  p.set("$where", where);
  return `https://${src.domain}/resource/${src.dataset}.json?${p.toString()}`;
}

export function rowSourceUrl(src: StateSource, id: string): string {
  return `https://${src.domain}/resource/${src.dataset}.json?${encodeURIComponent(src.idField)}=${encodeURIComponent(id)}`;
}

const INACTIVE_RE = /\b(dissolv|inactive|revok|forfeit|withdraw|cancel|expired|merged|delinquent|noncompliant|terminat|administratively)/i;

/** Matched-name tier: 3 exact (ignoring punctuation, &/and, suffix spelling), 2 prefix, 1 all tokens, 0 other. */
export function matchTier(query: string, name: string): number {
  if (canonicalName(query) === canonicalName(name)) return 3;
  const q = coreTokens(query);
  const n = coreTokens(name);
  if (q.join(" ") === n.join(" ")) return 3;
  if (n.join(" ").startsWith(q.join(" "))) return 2;
  if (q.every((t) => n.includes(t))) return 1;
  return 0;
}

/** Rank: exact > prefix > token match > others; active before inactive; then similarity and shorter names. */
export function rankEntities(rows: NormalizedEntity[], query?: string): NormalizedEntity[] {
  if (!query) return rows;
  const q = coreTokens(query).join(" ");
  return rows
    .map((e, i) => ({
      e,
      i,
      tier: matchTier(query, e.name),
      active: e.status && INACTIVE_RE.test(e.status) ? 0 : 1,
      sim: dice(q, coreTokens(e.name).join(" ")),
    }))
    .sort((a, b) => b.tier - a.tier || b.active - a.active || b.sim - a.sim || a.e.name.length - b.e.name.length || a.i - b.i)
    .map((x) => x.e);
}

export interface StatePage {
  entities: NormalizedEntity[];
  query_url: string;
  offset: number;
  has_more: boolean;
  /** Exact total when requested (include_total) or when the last page was reached. */
  total?: number;
  /** The dataset only lists active entities (no status filter needed or possible). */
  active_only_dataset?: boolean;
  note?: string;
}

export async function searchState(
  code: string,
  opts: {
    name?: string;
    entityId?: string;
    mode: MatchMode;
    limit: number;
    offset?: number;
    includeTotal?: boolean;
    activeOnly?: boolean;
    includeAgentDetails?: boolean;
    suppression?: Suppression;
  },
): Promise<StatePage> {
  const src = STATE_SOURCES[code];
  if (!src) throw new ToolError("UNSUPPORTED", `State ${code} is not supported.`);
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new ToolError("INVALID_INPUT", `offset must be 0..${MAX_OFFSET}.`);
  // Load the suppression list BEFORE any upstream request: refuse (cold start, Redis down) early.
  const suppression = opts.suppression ?? (await loadSuppression());
  const where = buildWhere(src, opts);
  if (!where) throw new ToolError("INVALID_INPUT", "Provide name or entity_id.");
  const order = buildOrder(src, opts.name);
  let url: string;
  let page: NormalizedEntity[];
  let hasMore: boolean;
  let note: string | undefined;
  const fetchRows = async (u: string) => {
    const rows = await getJson<Record<string, unknown>[]>(u, "socrata", TTL.stateSearch);
    if (!Array.isArray(rows)) throw new ToolError("UPSTREAM_ERROR", `Unexpected response from ${src.domain}`);
    return rows;
  };
  const totalP = opts.includeTotal ? countState(src, where) : undefined;
  if (src.multiRow) {
    // Row-per-associated-name dataset: fetch a window from the start, group by id, then slice.
    const want = Math.min(MULTIROW_WINDOW, (offset + opts.limit + 1) * (src.rowsPerEntity ?? 4));
    url = buildQueryUrl(src, where, want, { order });
    const rows = await fetchRows(url);
    let all = src.normalize(rows, (id) => rowSourceUrl(src, id));
    const truncated = rows.length >= want;
    if (truncated && all.length > 1) all = all.slice(0, -1); // last entity may be missing rows
    page = all.slice(offset, offset + opts.limit);
    hasMore = all.length > offset + opts.limit || truncated;
    if (truncated && want >= MULTIROW_WINDOW && all.length <= offset + opts.limit)
      note = `${src.code} lists one row per associated name; pagination covers the first ${MULTIROW_WINDOW} rows only. Refine the name (match='exact' or 'starts_with') to see more.`;
  } else {
    // One row (or one group) per entity: precise server-side pagination, one extra row for has_more.
    url = buildQueryUrl(src, where, opts.limit + 1, { order, offset });
    const rows = await fetchRows(url);
    hasMore = rows.length > opts.limit;
    page = src.normalize(hasMore ? rows.slice(0, opts.limit) : rows, (id) => rowSourceUrl(src, id));
  }
  const ranked = rankEntities(page, opts.name);
  const entities = applyPrivacy(ranked.map(cleanEntityText), { includeAgentDetails: !!opts.includeAgentDetails, suppression });
  let total = totalP ? await totalP : undefined;
  if (total === undefined && !hasMore && !note) total = offset + entities.length;
  return { entities, query_url: url, offset, has_more: hasMore, total, active_only_dataset: src.activeWhere ? undefined : true, note };
}

async function countState(src: StateSource, where: string): Promise<number | undefined> {
  const rows = await getJson<{ n?: string }[]>(buildCountUrl(src, where), "socrata", TTL.stateSearch);
  const n = Array.isArray(rows) ? Number(rows[0]?.n) : NaN;
  return Number.isFinite(n) ? n : undefined;
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
