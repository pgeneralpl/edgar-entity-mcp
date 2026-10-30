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
/** Max total characters of those variants (keeps $where + $order well below URL limits for long names). */
export const MAX_VARIANT_CHARS = 1200;
/** Max tokens used in a LIKE pattern. */
const MAX_PATTERN_TOKENS = 8;
/** Largest offset anonymous (keyless) HTTP callers may request: limits bulk enumeration of registries. */
export const ANON_MAX_OFFSET = 100;
/** In starts_with mode at least one pattern token must be this long ("A%" would match a large share of a registry). */
export const MIN_STARTS_WITH_TOKEN = 2;
/** Longest entity name (after NFKC) used to build queries: bounds the $where/$order URL length (no 414 that is still charged). */
export const NAME_MAX_CHARS = 100;
/** In contains mode at least one pattern token must be this long ("%A%B%" would match almost everything). */
export const MIN_CONTAINS_TOKEN = 3;
/** State entity ids: letters, digits and dashes only. */
export const ENTITY_ID_RE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * Largest useful offset for a row-per-name dataset (OR): its pagination covers a MULTIROW_WINDOW-row
 * window grouped into entities (~rowsPerEntity rows each), so pages past this offset are empty.
 */
export function multiRowMaxOffset(src: Pick<StateSource, "rowsPerEntity">): number {
  return Math.floor(MULTIROW_WINDOW / (src.rowsPerEntity ?? 4)) - 1;
}

/** States whose page at `offset` would certainly be empty (no request is made, nothing is charged). */
export function statesBeyondWindow(states: string[], offset: number): string[] {
  return states.filter((st) => {
    const src = STATE_SOURCES[st];
    return !!src?.multiRow && offset > multiRowMaxOffset(src);
  });
}

/**
 * Escape a value for a SoQL string literal: quotes are doubled and backslashes removed (an escape
 * character must never reach the query; names and ids never need one).
 */
export function soqlString(v: string): string {
  return `'${v.replace(/\\/g, "").replace(/'/g, "''")}'`;
}

/** Characters kept in the as-typed exact-match variant (everything else becomes a space). */
const TYPED_UNSAFE = /[^A-Z0-9 &.,'-]+/g;

/**
 * NFKC-normalise an entity name (fullwidth "ＡＣＭＥ" -> "ACME", ligatures, compatibility forms) and
 * enforce NAME_MAX_CHARS. Every name that reaches a query or ranking goes through this first.
 */
export function prepareEntityName(name: string): string {
  const n = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (n.length > NAME_MAX_CHARS)
    throw new ToolError("INVALID_INPUT", `name is limited to ${NAME_MAX_CHARS} characters.`, "Use the distinctive part of the name; matching ignores legal suffixes and punctuation.");
  return n;
}

/** NFKC, upper-case, collapse whitespace and drop LIKE wildcards. */
export function cleanNameQuery(q: string): string {
  return q
    .normalize("NFKC")
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
 * without a legal suffix, common suffixes are appended too. Bounded to MAX_VARIANTS and MAX_VARIANT_CHARS.
 */
export function nameVariants(name: string, opts: { addSuffixes?: boolean } = {}): string[] {
  const out = new Set<string>();
  let chars = 0;
  const add = (v: string) => {
    if (out.size >= MAX_VARIANTS || out.has(v) || chars + v.length > MAX_VARIANT_CHARS) return;
    out.add(v);
    chars += v.length;
  };
  // The as-typed spelling ("AT&T INC.") reduced to an allowlisted charset: the raw input never reaches $where/$order.
  const typed = cleanNameQuery(name).replace(TYPED_UNSAFE, " ").replace(/\s+/g, " ").trim();
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
  if (mode === "contains") assertContainsName(name);
  if (mode === "starts_with") assertStartsWithName(name);
  // Tokens in order with anything between them: "Tiffany and Company" -> TIFFANY% (matches "TIFFANY & CO.").
  const body = tokens.join("%");
  return `${f} like ${soqlString(mode === "starts_with" ? `${body}%` : `%${body}%`)}`;
}

/** Throws INVALID_INPUT unless a contains-mode name has at least one token of MIN_CONTAINS_TOKEN+ chars. */
export function assertContainsName(name: string): void {
  const tokens = patternTokens(name);
  if (!tokens.length) throw new ToolError("INVALID_INPUT", "name must contain letters or digits.");
  if (!tokens.some((t) => t.length >= MIN_CONTAINS_TOKEN))
    throw new ToolError(
      "INVALID_INPUT",
      `match='contains' needs at least one name word of ${MIN_CONTAINS_TOKEN}+ letters or digits (legal suffixes like Inc/LLC do not count).`,
      "Use a longer name fragment, or match='starts_with' / 'exact' for very short names.",
    );
}

/** Throws INVALID_INPUT unless a starts_with name has at least one token of MIN_STARTS_WITH_TOKEN+ chars. */
export function assertStartsWithName(name: string): void {
  const tokens = patternTokens(name);
  if (!tokens.length) throw new ToolError("INVALID_INPUT", "name must contain letters or digits.");
  if (!tokens.some((t) => t.length >= MIN_STARTS_WITH_TOKEN))
    throw new ToolError(
      "INVALID_INPUT",
      `match='starts_with' needs at least one name word of ${MIN_STARTS_WITH_TOKEN}+ letters or digits (legal suffixes like Inc/LLC do not count).`,
      "Use a longer name prefix, or match='exact' for single-letter names.",
    );
}

export function assertEntityId(id: string): string {
  const v = id.trim();
  if (!ENTITY_ID_RE.test(v)) throw new ToolError("INVALID_INPUT", "entity_id may contain only letters, digits and '-' (max 40).");
  return v;
}

export function buildWhere(src: StateSource, opts: { name?: string; entityId?: string; mode: MatchMode; activeOnly?: boolean }): string {
  const clauses: string[] = [];
  if (opts.activeOnly && src.activeWhere) clauses.push(src.activeWhere);
  if (opts.entityId) clauses.push(`${src.idField} = ${soqlString(assertEntityId(opts.entityId))}`);
  if (opts.name) clauses.push(nameClause(src, prepareEntityName(opts.name), opts.mode));
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
    name = prepareEntityName(name);
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
  if (opts.name) opts = { ...opts, name: prepareEntityName(opts.name) }; // also used for client-side ranking
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new ToolError("INVALID_INPUT", `offset must be 0..${MAX_OFFSET}.`);
  // Load the suppression list BEFORE any upstream request: refuse (cold start, Redis down) early.
  const suppression = opts.suppression ?? (await loadSuppression());
  if (src.multiRow && offset > multiRowMaxOffset(src)) {
    // Past the row window every page is empty: answer without an upstream request (and so without a charge).
    return {
      entities: [],
      query_url: buildQueryUrl(src, buildWhere(src, opts), MULTIROW_WINDOW, { order: buildOrder(src, opts.name) }),
      offset,
      has_more: false,
      active_only_dataset: src.activeWhere ? undefined : true,
      note: `${src.code} pagination covers the first ${MULTIROW_WINDOW} rows (about ${multiRowMaxOffset(src) + 1} entities); offset ${offset} is past it. Refine the name (match='exact' or 'starts_with') to see more.`,
    };
  }
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
  // The count runs in parallel with the page fetch. Its rejection is handled at creation: if the page
  // fetch throws first, nobody awaits totalP, and an unhandled rejection would crash the process.
  const totalP = opts.includeTotal ? countState(src, where).catch(() => undefined) : undefined;
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
    // Never point next_offset past the window (those pages are always empty; see multiRowMaxOffset).
    const atWindowEnd = offset + opts.limit > multiRowMaxOffset(src);
    const beyond = truncated || all.length > offset + opts.limit;
    if (atWindowEnd) hasMore = false;
    if ((atWindowEnd && beyond) || (truncated && want >= MULTIROW_WINDOW && all.length <= offset + opts.limit))
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
