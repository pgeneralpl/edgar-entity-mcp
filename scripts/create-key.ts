/**
 * Mint / revoke free API keys for the hosted endpoint. Keys are shown once; only SHA-256 hashes are stored in Redis.
 *
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npx tsx scripts/create-key.ts --label "gh-issue-42"
 *   ... scripts/create-key.ts --label "gh-issue-43" --per-day 20000
 *
 * The label is stored with the key hash; use a reference (e.g. the GitHub issue number), not a
 * name or email address — keep contact details in the issue tracker, not in Redis.
 *   ... scripts/create-key.ts --revoke <key-or-sha256>
 */
import { Redis } from "@upstash/redis";
import { config } from "../src/config.js";
import { generateApiKey, revokeApiKey, storeApiKey } from "../src/core/apiKeys.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const c = config();
if (!c.upstashUrl || !c.upstashToken) {
  console.error("Set UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN), e.g. via `vercel env pull`.");
  process.exit(2);
}
const redis = new Redis({ url: c.upstashUrl, token: c.upstashToken, automaticDeserialization: false });

const revoke = opt("revoke");
if (revoke) {
  console.log((await revokeApiKey(redis, revoke)) ? "revoked" : "not found");
  process.exit(0);
}
const name = opt("label") ?? opt("name");
if (!name) {
  console.error('Usage: create-key.ts --label "<reference, e.g. gh-issue-42>" [--per-day N] [--per-minute N] | --revoke <key-or-hash>');
  process.exit(2);
}
const perDay = opt("per-day") ? Number(opt("per-day")) : undefined;
const perMinute = opt("per-minute") ? Number(opt("per-minute")) : undefined;
const key = generateApiKey();
if (/@|\s/.test(name) && !args.includes("--allow-personal-label")) {
  console.error("Refusing a label that looks like a name or email address; use a reference such as gh-issue-42 (or pass --allow-personal-label).");
  process.exit(2);
}
const hash = await storeApiKey(redis, key, { name, created: new Date().toISOString().slice(0, 10), per_day: perDay, per_minute: perMinute });
console.log(JSON.stringify({ api_key: key, sha256: hash, name, per_day: perDay ?? c.quota.keyPerDay, per_minute: perMinute ?? c.quota.keyPerMinute }, null, 2));
console.error("Give the api_key to the user once; it cannot be recovered (only the hash is stored).");
