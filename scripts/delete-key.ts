/**
 * Delete an API key and everything stored about it: the `apikey:<id>` record and any of its quota
 * counters still alive (`q:d:key:<id>:*`, `q:m:key:<id>:*`). Accepts the full key or the key id.
 *
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... IP_HASH_SALT=... npx tsx scripts/delete-key.ts <key-or-id>
 *
 * Running instances memoise key lookups for at most 5 minutes, so a deleted key stops working
 * within 5 minutes everywhere. For immediate revocation (also while Redis is unavailable, when
 * MAC-valid keys are accepted unverified) add the id to REVOKED_KEY_IDS; rotating API_KEY_SECRET
 * revokes all keys.
 */
import { Redis } from "@upstash/redis";
import { config } from "../src/config.js";
import { deleteApiKey, keyIdOf } from "../src/core/apiKeys.js";

const target = process.argv[2];
if (!target || !keyIdOf(target)) {
  console.error("Usage: delete-key.ts <eem_… key or 12-character key id>");
  process.exit(2);
}
const c = config();
if (!c.upstashUrl || !c.upstashToken) {
  console.error("Set UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN), e.g. via `vercel env pull`.");
  process.exit(2);
}
const redis = new Redis({ url: c.upstashUrl, token: c.upstashToken, automaticDeserialization: false });
const r = await deleteApiKey(redis, target);
console.log(JSON.stringify({ key_id: keyIdOf(target), record_deleted: r.record, counters_deleted: r.counters }));
