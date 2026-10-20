/**
 * Mint a free API key for the hosted endpoint. The key is printed once and cannot be recovered.
 *
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... IP_HASH_SALT=... [API_KEY_SECRET=...] \
 *     npx tsx scripts/create-key.ts [--per-day N] [--per-minute N]
 *
 * Keys are self-verifying: eem_<id>_<HMAC(API_KEY_SECRET, id)>. Redis stores only
 * `apikey:<id>` = { created, per_day?, per_minute? } — no name, email or contact. Record the id
 * (not the key) in the request issue if you need to find it later. Delete with scripts/delete-key.ts.
 * The script must run with the same API_KEY_SECRET (or IP_HASH_SALT, if API_KEY_SECRET is unset) as
 * the deployment, or the minted keys will not verify there.
 */
import { Redis } from "@upstash/redis";
import { config } from "../src/config.js";
import { generateApiKey, storeApiKey } from "../src/core/apiKeys.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const known = new Set(["--per-day", "--per-minute"]);
for (let i = 0; i < args.length; i += 2)
  if (!known.has(args[i]!)) {
    console.error(`Unknown option ${args[i]}. Usage: create-key.ts [--per-day N] [--per-minute N]  (no names or contacts are stored)`);
    process.exit(2);
  }
const c = config();
if (!c.upstashUrl || !c.upstashToken) {
  console.error("Set UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN), e.g. via `vercel env pull`.");
  process.exit(2);
}
if (c.startupProblem) {
  console.error(c.startupProblem);
  process.exit(2);
}
const num = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Not a positive integer: ${v}`);
    process.exit(2);
  }
  return n;
};
const perDay = num(opt("per-day"));
const perMinute = num(opt("per-minute"));
const redis = new Redis({ url: c.upstashUrl, token: c.upstashToken, automaticDeserialization: false });
const { key, id } = generateApiKey();
await storeApiKey(redis, id, { created: new Date().toISOString().slice(0, 10), per_day: perDay, per_minute: perMinute });
console.log(JSON.stringify({ api_key: key, key_id: id, per_day: perDay ?? c.quota.keyPerDay, per_minute: perMinute ?? c.quota.keyPerMinute }, null, 2));
console.error("Give the api_key to the holder once; it cannot be recovered. Keep only key_id for later deletion.");
