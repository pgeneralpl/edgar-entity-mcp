import { loadConfig } from "../config.js";
import { getRedis } from "../core/cache.js";
import { logError } from "../core/errors.js";
import { readStats, STATS_MAX_DAYS } from "../core/stats.js";
import { secretMatches } from "./health.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * GET /stats?days=N (1..30, default 7) with header `x-stats-secret: <STATS_SECRET>`.
 * Returns the aggregate daily counters (src/core/stats.ts) and totals. Only counts are returned:
 * unique clients come from HyperLogLog cardinalities, never member values.
 * STATS_SECRET unset (or < 32 chars) = endpoint disabled (404); wrong/missing secret = 401.
 */
export async function statsResponse(req: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
  const c = loadConfig(env);
  if (!c.statsSecret) return json(404, { error: "not_found", message: "stats endpoint is disabled" });
  if (!secretMatches(req.headers.get("x-stats-secret"), c.statsSecret))
    return json(401, { error: "unauthorized", message: "stats require a valid x-stats-secret header" });
  const raw = new URL(req.url).searchParams.get("days");
  const days = raw === null || raw === "" ? 7 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > STATS_MAX_DAYS)
    return json(400, { error: "invalid_input", message: `days must be an integer from 1 to ${STATS_MAX_DAYS}` });
  const redis = getRedis();
  if (!redis) return json(503, { error: "unavailable", message: "stats need Redis (Upstash) to be configured" });
  try {
    const out = await readStats(redis, days);
    return json(200, {
      stats_enabled: c.statsEnabled,
      days_requested: days,
      generated_at: new Date().toISOString(),
      note: "Approximate aggregate counters per UTC day. unique_clients_approx is a HyperLogLog estimate over daily-salted hashes; the same client is counted once per day.",
      totals: out.totals,
      days: out.days,
    });
  } catch (e) {
    logError("stats-read", e);
    return json(503, { error: "unavailable", message: "stats are temporarily unavailable" });
  }
}
