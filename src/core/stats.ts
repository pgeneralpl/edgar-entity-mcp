import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { config } from "../config.js";
import { getRedis } from "./cache.js";
import { isRedisCapacityError, onRedisDegraded, redisDegraded } from "./degraded.js";
import type { Principal } from "./quota.js";
import type { UsageResult } from "./usage.js";

/**
 * Aggregate daily usage counters (STATS_ENABLED, default on; Redis only; on Vercel only when
 * VERCEL_ENV=production, so preview deployments never write to the shared database).
 *
 * Per UTC day D (every write sets EXPIREAT end(D) + STATS_RETENTION_DAYS, so keys always carry a TTL):
 *   stats:D:c   HASH  calls:<tool> ok:<tool> err:<tool>, ec:<ERROR_CODE>, tier:anon|key, init,
 *                     degraded, lat:<bucket ms>, flush_fail
 *   stats:D:u   HLL   approximate unique clients: HMAC(random daily salt, principal id), truncated
 *   stats:D:cl  ZSET  allowlisted client-software label ("cursor/1", "claude", ..., else "other"),
 *                     counted once per principal per day (per instance), after its first successful call
 *   stats:salt:D      the random daily salt; expires at end(D) + 1 h. Until then the HLL members are
 *                     pseudonymous (whoever holds the salt and a principal id can test membership);
 *                     afterwards nobody can. No HLL member is added after end(D) + 1 h.
 * At most 3 keys per day are kept (+1 salt key), i.e. ≤ 3 × 31 + 2 keys in total.
 *
 * Cost control: events are aggregated per instance in memory and written with ONE script call
 * (EVALSHA) per flush; an instance flushes at most once per STATS_FLUSH_INTERVAL_MS (the first
 * event after a quiet period flushes immediately, later ones are coalesced into a trailing flush).
 * Writes are fire-and-forget with a short timeout: a stats failure never fails or slows a request,
 * never trips degraded mode, and simply drops that batch (counted as flush_fail when possible).
 */
export const STATS_RETENTION_DAYS = 30;
/** The daily salt lives until this long after the end of its UTC day. */
export const STATS_SALT_GRACE_SECONDS = 3600;
export const STATS_FLUSH_INTERVAL_MS = 60_000;
export const STATS_TIMEOUT_MS = 1_500;
export const STATS_TOP_CLIENTS = 50;
export const STATS_MAX_DAYS = 30;
/**
 * Bounds on what one instance keeps pending between flushes (and so on one flush's size, ≤ ~6 KB):
 * at most 100 distinct clients per instance per interval reach the HLL (an undercount only under
 * heavy load) and at most 20 distinct client labels (the rest are counted as "other").
 */
export const STATS_MAX_PENDING_MEMBERS = 100;
export const STATS_MAX_PENDING_CLIENTS = 20;
/** Memory bounds for the per-instance "label once per principal per day" bookkeeping. */
export const STATS_MAX_TRACKED_PRINCIPALS = 2_000;
export const STATS_MAX_PENDING_DAYS = 2;
/** Upper edges (ms) of the latency histogram buckets; anything slower lands in "inf". */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000] as const;
const ERROR_BACKOFF_MS = 60_000;
const FULL_BACKOFF_MS = 10 * 60_000;

const KNOWN_ERROR_CODES = new Set([
  "INVALID_INPUT",
  "NOT_FOUND",
  "AMBIGUOUS",
  "UPSTREAM_ERROR",
  "RATE_LIMITED",
  "UNSUPPORTED",
  "UNAUTHORIZED",
  "CONFIG_ERROR",
  "INTERNAL",
]);

/** KEYS: c, u, cl. ARGV: expireat (unix s), cap, nMembers, nClients, members…, (client, count)…, (field, incr)… */
export const STATS_FLUSH_SCRIPT = `
local exp = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local nm = tonumber(ARGV[3])
local nc = tonumber(ARGV[4])
local i = 5
if nm > 0 then
  redis.call('PFADD', KEYS[2], unpack(ARGV, i, i + nm - 1))
  redis.call('EXPIREAT', KEYS[2], exp)
end
i = i + nm
if nc > 0 then
  for j = i, i + 2 * nc - 1, 2 do redis.call('ZINCRBY', KEYS[3], ARGV[j + 1], ARGV[j]) end
  local n = redis.call('ZCARD', KEYS[3])
  if n > cap then redis.call('ZREMRANGEBYRANK', KEYS[3], 0, n - cap - 1) end
  redis.call('EXPIREAT', KEYS[3], exp)
end
i = i + 2 * nc
if i <= #ARGV then
  for j = i, #ARGV, 2 do redis.call('HINCRBY', KEYS[1], ARGV[j], ARGV[j + 1]) end
  redis.call('EXPIREAT', KEYS[1], exp)
end
return 1
`;
export const STATS_FLUSH_SCRIPT_SHA = createHash("sha1").update(STATS_FLUSH_SCRIPT).digest("hex");

/** KEYS: salt key. ARGV: candidate salt, ttl seconds. Returns the day's salt (creating it once). */
export const STATS_SALT_SCRIPT = `
local s = redis.call('GET', KEYS[1])
if s then return s end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return ARGV[1]
`;
export const STATS_SALT_SCRIPT_SHA = createHash("sha1").update(STATS_SALT_SCRIPT).digest("hex");

/** KEYS: (c, u, cl) per day. ARGV: top N. Returns per day {hash flat list, pfcount, zset flat list}. */
export const STATS_READ_SCRIPT = `
local out = {}
local top = tonumber(ARGV[1])
for i = 1, #KEYS, 3 do
  out[#out + 1] = {
    redis.call('HGETALL', KEYS[i]),
    redis.call('PFCOUNT', KEYS[i + 1]),
    redis.call('ZREVRANGE', KEYS[i + 2], 0, top - 1, 'WITHSCORES')
  }
end
return out
`;
export const STATS_READ_SCRIPT_SHA = createHash("sha1").update(STATS_READ_SCRIPT).digest("hex");

export function isoDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
/** End of UTC day `day` (YYYY-MM-DD) in ms since the epoch. */
export function dayEndMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + 86400_000;
}
/** Absolute expiry (unix seconds) of a day's stats keys: end of the day + retention. */
export function statsExpireAt(day: string): number {
  return Math.floor(dayEndMs(day) / 1000) + STATS_RETENTION_DAYS * 86400;
}
/** Seconds until day D's salt must be gone (end(D) + 1 h − now); ≤ 0 means no more HLL writes for D. */
export function saltTtlSeconds(day: string, now: number): number {
  return Math.floor((dayEndMs(day) + STATS_SALT_GRACE_SECONDS * 1000 - now) / 1000);
}
export function statsKeys(day: string): { c: string; u: string; cl: string; salt: string } {
  const p = `${config().cachePrefix}stats:`;
  return { c: `${p}${day}:c`, u: `${p}${day}:u`, cl: `${p}${day}:cl`, salt: `${p}salt:${day}` };
}

export function latencyBucket(ms: number): string {
  for (const b of LATENCY_BUCKETS_MS) if (ms <= b) return String(b);
  return "inf";
}
function toolField(tool: string): string {
  return /^[a-z][a-z0-9_]{0,47}$/.test(tool) ? tool : "other";
}
function errorField(code: string | undefined): string {
  return code && KNOWN_ERROR_CODES.has(code) ? code : "OTHER";
}

/**
 * Allowlist of well-known MCP clients: label → accepted name stems. clientInfo.name is lowercased,
 * NFKC-normalized and stripped to [a-z0-9]; it matches when it equals a stem, optionally followed
 * by one generic suffix (CLIENT_SUFFIXES). Anything else is recorded as "other", so no free text
 * supplied by a client ever reaches Redis.
 */
const KNOWN_CLIENTS: [label: string, stems: string[]][] = [
  ["claude-code", ["claudecode"]],
  ["claude", ["claude", "claudeai", "claudedesktop", "anthropic"]],
  ["cursor", ["cursor", "cursorvscode"]],
  ["vscode", ["vscode", "visualstudiocode", "visualstudiocodeinsiders", "githubcopilot", "copilot"]],
  ["mcp-inspector", ["mcpinspector", "inspector", "modelcontextprotocolinspector"]],
  ["windsurf", ["windsurf", "codeium"]],
  ["zed", ["zed", "zedindustries"]],
  ["continue", ["continue", "continuedev"]],
  ["cline", ["cline"]],
  ["roo-code", ["roocode", "roocline"]],
  ["goose", ["goose"]],
  ["openai", ["openai", "chatgpt", "codex", "openaicodex"]],
  ["gemini", ["gemini", "geminicli", "googlegemini"]],
  ["librechat", ["librechat", "librechatapi"]],
  ["n8n", ["n8n"]],
  ["mcp-remote", ["mcpremote"]],
  ["jetbrains", ["jetbrains", "jetbrainsai", "junie"]],
  ["amazon-q", ["amazonq", "qdeveloper"]],
  ["lm-studio", ["lmstudio"]],
  ["cherry-studio", ["cherrystudio"]],
  ["5ire", ["5ire"]],
  ["warp", ["warp"]],
  ["postman", ["postman"]],
  ["opencode", ["opencode"]],
  ["fast-agent", ["fastagent"]],
  ["mcp-use", ["mcpuse"]],
  ["smithery", ["smithery"]],
];
const CLIENT_SUFFIXES = ["", "client", "mcpclient", "mcp", "cli", "climcpclient", "desktop", "app", "ide", "extension"];
const CLIENT_LOOKUP = new Map<string, string>();
for (const [label, stems] of KNOWN_CLIENTS)
  for (const stem of stems) for (const suf of CLIENT_SUFFIXES) if (!CLIENT_LOOKUP.has(stem + suf)) CLIENT_LOOKUP.set(stem + suf, label);
/** All labels that can ever be recorded (plus "other"). */
export const STATS_CLIENT_LABELS: readonly string[] = [...KNOWN_CLIENTS.map(([l]) => l), "other"];

/**
 * Client-software label from MCP initialize clientInfo: an allowlisted label plus the major
 * version when it is a plain number ("cursor/1", "claude"), or "other" for anything unknown.
 */
export function normalizeClient(info: unknown): string {
  const o = info && typeof info === "object" ? (info as Record<string, unknown>) : {};
  const raw = typeof o.name === "string" ? o.name.slice(0, 200) : "";
  const key = raw.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const label = CLIENT_LOOKUP.get(key);
  if (!label) return "other";
  const m = typeof o.version === "string" ? /^\s*v?(\d{1,4})(?:[.\s-]|$)/i.exec(o.version) : null;
  return m ? `${label}/${Number(m[1])}` : label;
}

interface Delta {
  fields: Map<string, number>;
  /** Principal ids (already hashed for IPs); salted and hashed again at flush time. Memory only. */
  members: Set<string>;
  clients: Map<string, number>;
}

interface State {
  pending: Map<string, Delta>;
  inFlight?: Promise<void>;
  lastFlushAt: number;
  backoffUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  salts: Map<string, string>;
  /** principal id → client label from its latest initialize on this instance (memory only). */
  labels: Map<string, string>;
  /** "day\0principal\0label" already counted on this instance (memory only, cleared daily). */
  counted: Set<string>;
  countedDay: string;
  failures: number;
  enabledOverride?: boolean;
}
const st: State = { pending: new Map(), lastFlushAt: 0, backoffUntil: 0, salts: new Map(), labels: new Map(), counted: new Set(), countedDay: "", failures: 0 };

function enabled(): boolean {
  return st.enabledOverride ?? config().statsEnabled;
}

/** Tests: drop all pending state; `enabled` overrides STATS_ENABLED (undefined = follow config). */
export function resetStats(opts: { enabled?: boolean } = {}): void {
  if (st.timer) clearTimeout(st.timer);
  st.pending.clear();
  st.salts.clear();
  st.labels.clear();
  st.counted.clear();
  st.countedDay = "";
  st.inFlight = undefined;
  st.timer = undefined;
  st.lastFlushAt = 0;
  st.backoffUntil = 0;
  st.failures = 0;
  st.enabledOverride = opts.enabled;
}

function delta(day: string): Delta | undefined {
  let d = st.pending.get(day);
  if (!d) {
    if (st.pending.size >= STATS_MAX_PENDING_DAYS) {
      // Bound memory: drop the oldest pending day (only happens if Redis has been unreachable for a day).
      const oldest = [...st.pending.keys()].sort()[0]!;
      st.pending.delete(oldest);
    }
    d = { fields: new Map(), members: new Set(), clients: new Map() };
    st.pending.set(day, d);
  }
  return d;
}
const inc = (d: Delta, field: string, by = 1) => d.fields.set(field, (d.fields.get(field) ?? 0) + by);
function addMember(d: Delta, p: Principal | undefined) {
  if (p && d.members.size < STATS_MAX_PENDING_MEMBERS) d.members.add(p.id);
}

/** Usage hook: one tool call finished (HTTP transport only). Never throws, never awaits Redis. */
export function recordToolCall(e: UsageResult, now = Date.now()): void {
  try {
    if (!enabled() || e.transport !== "http") return;
    const d = delta(isoDay(now))!;
    const t = toolField(e.tool);
    inc(d, `calls:${t}`);
    inc(d, e.ok ? `ok:${t}` : `err:${t}`);
    if (!e.ok) inc(d, `ec:${errorField(e.errorCode)}`);
    if (e.principal) inc(d, `tier:${e.principal.tier === "anon" ? "anon" : "key"}`);
    if (Number.isFinite(e.ms)) inc(d, `lat:${latencyBucket(e.ms)}`);
    addMember(d, e.principal);
    if (e.ok && e.principal) countClientLabel(d, isoDay(now), e.principal.id);
    schedule(now);
  } catch {
    /* stats must never affect a request */
  }
}

/** Count the principal's client label once per day, on (or after) its first successful tool call. */
function countClientLabel(d: Delta, day: string, principalId: string): void {
  const label = st.labels.get(principalId);
  if (!label) return;
  if (st.countedDay !== day) {
    st.counted.clear();
    st.countedDay = day;
  }
  const k = `${principalId}\0${label}`;
  if (st.counted.has(k) || st.counted.size >= STATS_MAX_TRACKED_PRINCIPALS) return;
  st.counted.add(k);
  const slot = d.clients.has(label) || d.clients.size < STATS_MAX_PENDING_CLIENTS ? label : "other";
  d.clients.set(slot, (d.clients.get(slot) ?? 0) + 1);
}

/**
 * An MCP initialize request (one session). Counts the session and remembers the principal's
 * allowlisted client label in memory; the label is only counted after a successful tool call.
 */
export function recordInitialize(principal: Principal | undefined, clientInfo: unknown, now = Date.now()): void {
  try {
    if (!enabled()) return;
    const d = delta(isoDay(now))!;
    inc(d, "init");
    if (principal) {
      st.labels.delete(principal.id);
      if (st.labels.size >= STATS_MAX_TRACKED_PRINCIPALS) st.labels.delete(st.labels.keys().next().value!);
      st.labels.set(principal.id, normalizeClient(clientInfo));
    }
    schedule(now);
  } catch {
    /* never affects a request */
  }
}

onRedisDegraded(() => {
  try {
    if (enabled()) inc(delta(isoDay())!, "degraded"); // written after Redis recovers
  } catch {
    /* ignore */
  }
});

/** Hand a background promise to the Vercel runtime so it is not frozen mid-flush (no-op elsewhere). */
function waitUntil(p: Promise<unknown>): void {
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
      Symbol.for("@vercel/request-context")
    ];
    ctx?.get?.()?.waitUntil?.(p);
  } catch {
    /* not on Vercel */
  }
}

function schedule(now: number): void {
  if (st.inFlight || st.timer) return; // a flush is pending; it will pick these events up
  if (redisDegraded()) return; // 0 commands; the first event after recovery flushes what is pending
  const wait = Math.max(st.lastFlushAt + STATS_FLUSH_INTERVAL_MS, st.backoffUntil) - now;
  if (wait <= 0) {
    void startFlush();
    return;
  }
  // Trailing flush; unref'd so it never keeps a process alive. If the instance is frozen first,
  // the next event after the interval flushes (or the batch is lost: counters are approximate).
  st.timer = setTimeout(() => {
    st.timer = undefined;
    void startFlush();
  }, wait);
  st.timer.unref?.();
}

function startFlush(): Promise<void> {
  if (st.inFlight) return st.inFlight;
  const p = flushStats()
    .catch(() => {})
    .finally(() => {
      st.inFlight = undefined;
      if (st.pending.size && enabled()) schedule(Date.now()); // events that arrived during the flush
    });
  st.inFlight = p;
  waitUntil(p);
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error("stats write timed out")), ms);
      t.unref?.();
    }),
  ]).finally(() => clearTimeout(t));
}

async function runScript(redis: Redis, sha: string, script: string, keys: string[], args: string[]): Promise<unknown> {
  try {
    return await redis.evalsha(sha, keys, args);
  } catch (e) {
    if (!/NOSCRIPT/i.test(String(e))) throw e;
    return await redis.eval(script, keys, args);
  }
}

async function daySalt(redis: Redis, day: string, now: number): Promise<string | undefined> {
  const ttl = saltTtlSeconds(day, now);
  if (ttl <= 0) {
    st.salts.delete(day);
    return undefined; // past end(D) + 1 h: the salt is (being) deleted, never write HLL members for D
  }
  const cached = st.salts.get(day);
  if (cached) return cached;
  const res = await runScript(redis, STATS_SALT_SCRIPT_SHA, STATS_SALT_SCRIPT, [statsKeys(day).salt], [randomBytes(32).toString("hex"), String(ttl)]);
  const salt = String(res);
  if (salt.length < 16) throw new Error("bad stats salt");
  st.salts.set(day, salt);
  return salt;
}

/** Forget in-memory salts of days before `today` (they are only needed during the 1 h grace). */
function pruneSalts(now: number): void {
  const today = isoDay(now);
  for (const k of st.salts.keys()) if (k < today) st.salts.delete(k);
}

/** Build the flush script arguments for one day's delta (exported for tests). */
export function flushArgs(day: string, d: Delta, salt: string | undefined): string[] {
  const members = salt ? [...d.members].map((id) => createHmac("sha256", salt).update(id).digest("hex").slice(0, 16)) : [];
  const clients = [...d.clients].flatMap(([k, v]) => [k, String(v)]);
  const fields = [...d.fields].filter(([, v]) => v !== 0).flatMap(([k, v]) => [k, String(v)]);
  return [String(statsExpireAt(day)), String(STATS_TOP_CLIENTS), String(members.length), String(d.clients.size), ...members, ...clients, ...fields];
}

/**
 * Write everything pending (normally one day = one EVALSHA, plus one salt lookup per instance per
 * day). Exported for tests; in production it is called by the scheduler only.
 */
export async function flushStats(now = Date.now()): Promise<void> {
  pruneSalts(now);
  if (!enabled() || !st.pending.size) return;
  const redis = getRedis();
  if (!redis) {
    st.pending.clear();
    return;
  }
  if (redisDegraded() || now < st.backoffUntil) return; // keep the (bounded) delta for later
  st.lastFlushAt = now;
  const batch = [...st.pending].sort(([a], [b]) => (a < b ? -1 : 1));
  st.pending.clear();
  for (const [day, d] of batch) {
    try {
      if (st.failures) {
        inc(d, "flush_fail", st.failures);
        st.failures = 0;
      }
      const salt = d.members.size ? await withTimeout(daySalt(redis, day, now), STATS_TIMEOUT_MS) : undefined;
      if (!salt) d.members.clear();
      const k = statsKeys(day);
      await withTimeout(runScript(redis, STATS_FLUSH_SCRIPT_SHA, STATS_FLUSH_SCRIPT, [k.c, k.u, k.cl], flushArgs(day, d, salt)), STATS_TIMEOUT_MS);
    } catch (e) {
      // Drop the batch (it may have been applied before a timeout; never double count) and back off.
      // Deliberately does not mark Redis degraded: stats are not worth disturbing quotas or caching.
      st.failures += 1;
      st.backoffUntil = Date.now() + (isRedisCapacityError(e) ? FULL_BACKOFF_MS : ERROR_BACKOFF_MS);
      return;
    }
  }
}

/** Pending state, for tests and diagnostics. */
export function statsPending(): {
  days: number;
  fields: number;
  members: number;
  clients: number;
  inFlight: boolean;
  scheduled: boolean;
  saltDays: string[];
  trackedPrincipals: number;
} {
  let fields = 0;
  let members = 0;
  let clients = 0;
  for (const d of st.pending.values()) {
    fields += d.fields.size;
    members += d.members.size;
    clients += d.clients.size;
  }
  return {
    days: st.pending.size,
    fields,
    members,
    clients,
    inFlight: !!st.inFlight,
    scheduled: !!st.timer,
    saltDays: [...st.salts.keys()],
    trackedPrincipals: st.labels.size,
  };
}

// ---------------------------------------------------------------- reading (GET /stats)

export interface DayStats {
  date: string;
  calls: number;
  ok: number;
  errors: number;
  tools: Record<string, { calls: number; ok: number; errors: number }>;
  error_codes: Record<string, number>;
  tiers: Record<string, number>;
  sessions: number;
  unique_clients_approx: number;
  /** Allowlisted client labels; count = principals seen with that label (once per principal per day per instance). */
  clients: { client: string; principals: number }[];
  degraded_activations: number;
  latency_ms: { buckets: Record<string, number>; p50?: string; p95?: string };
  flush_failures: number;
}

/** Approximate percentile from the fixed buckets: the upper edge of the bucket holding the q-th call. */
export function bucketPercentile(buckets: Record<string, number>, q: number): string | undefined {
  const order = [...LATENCY_BUCKETS_MS.map(String), "inf"];
  const total = order.reduce((s, b) => s + (buckets[b] ?? 0), 0);
  if (!total) return undefined;
  const target = Math.ceil(q * total);
  let seen = 0;
  for (const b of order) {
    seen += buckets[b] ?? 0;
    if (seen >= target) return b === "inf" ? `>${LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]}` : `<=${b}`;
  }
  return undefined;
}

function pairs(v: unknown): [string, string][] {
  if (Array.isArray(v)) {
    const out: [string, string][] = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push([String(v[i]), String(v[i + 1])]);
    return out;
  }
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]);
  return [];
}

export function parseDay(date: string, hash: unknown, unique: unknown, zset: unknown): DayStats {
  const s: DayStats = {
    date,
    calls: 0,
    ok: 0,
    errors: 0,
    tools: {},
    error_codes: {},
    tiers: {},
    sessions: 0,
    unique_clients_approx: Number(unique) || 0,
    clients: pairs(zset).map(([client, n]) => ({ client, principals: Number(n) || 0 })),
    degraded_activations: 0,
    latency_ms: { buckets: {} },
    flush_failures: 0,
  };
  const tool = (t: string) => (s.tools[t] ??= { calls: 0, ok: 0, errors: 0 });
  const bump = (into: Record<string, number>, k: string, n: number) => {
    into[k] = (into[k] ?? 0) + n;
  };
  for (const [f, raw] of pairs(hash)) {
    const n = Number(raw) || 0;
    const colon = f.indexOf(":");
    const kind = colon < 0 ? f : f.slice(0, colon);
    const name = colon < 0 ? "" : f.slice(colon + 1);
    switch (kind) {
      case "calls":
        tool(name).calls += n;
        s.calls += n;
        break;
      case "ok":
        tool(name).ok += n;
        s.ok += n;
        break;
      case "err":
        tool(name).errors += n;
        s.errors += n;
        break;
      case "ec":
        bump(s.error_codes, name, n);
        break;
      case "tier":
        bump(s.tiers, name, n);
        break;
      case "lat":
        bump(s.latency_ms.buckets, name, n);
        break;
      case "init":
        s.sessions += n;
        break;
      case "degraded":
        s.degraded_activations += n;
        break;
      case "flush_fail":
        s.flush_failures += n;
        break;
    }
  }
  s.latency_ms.p50 = bucketPercentile(s.latency_ms.buckets, 0.5);
  s.latency_ms.p95 = bucketPercentile(s.latency_ms.buckets, 0.95);
  return s;
}

const addInto = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

export function totals(days: DayStats[]) {
  const tools: Record<string, { calls: number; ok: number; errors: number }> = {};
  const error_codes: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  const buckets: Record<string, number> = {};
  const clients: Record<string, number> = {};
  let calls = 0,
    ok = 0,
    errors = 0,
    sessions = 0,
    degraded = 0,
    clientDays = 0;
  for (const d of days) {
    calls += d.calls;
    ok += d.ok;
    errors += d.errors;
    sessions += d.sessions;
    degraded += d.degraded_activations;
    clientDays += d.unique_clients_approx;
    for (const [t, v] of Object.entries(d.tools)) {
      const x = (tools[t] ??= { calls: 0, ok: 0, errors: 0 });
      x.calls += v.calls;
      x.ok += v.ok;
      x.errors += v.errors;
    }
    addInto(error_codes, d.error_codes);
    addInto(tiers, d.tiers);
    addInto(buckets, d.latency_ms.buckets);
    for (const c of d.clients) clients[c.client] = (clients[c.client] ?? 0) + c.principals;
  }
  return {
    calls,
    ok,
    errors,
    tools,
    error_codes,
    tiers,
    sessions,
    // Daily salts differ, so the same client counts once per day it was seen (not a unique total).
    unique_client_days_approx: clientDays,
    clients: Object.entries(clients)
      .sort((a, b) => b[1] - a[1])
      .slice(0, STATS_TOP_CLIENTS)
      .map(([client, n]) => ({ client, principal_days: n })),
    degraded_activations: degraded,
    latency_ms: { buckets, p50: bucketPercentile(buckets, 0.5), p95: bucketPercentile(buckets, 0.95) },
  };
}

/** Read N days (today first) with one script call (3 inner reads per day). */
export async function readStats(redis: Redis, days: number, now = Date.now()) {
  const n = Math.min(STATS_MAX_DAYS, Math.max(1, Math.floor(days)));
  const dates = Array.from({ length: n }, (_, i) => isoDay(now - i * 86400_000));
  const keys = dates.flatMap((d) => {
    const k = statsKeys(d);
    return [k.c, k.u, k.cl];
  });
  const res = (await runScript(redis, STATS_READ_SCRIPT_SHA, STATS_READ_SCRIPT, keys, [String(STATS_TOP_CLIENTS)])) as unknown[];
  const perDay = dates.map((date, i) => {
    const r = (Array.isArray(res?.[i]) ? res[i] : []) as unknown[];
    return parseDay(date, r[0], r[1], r[2]);
  });
  return { days: perDay, totals: totals(perDay) };
}
