/**
 * Manage the personal-data suppression list (erasure / objection requests) in Redis.
 * Instances refresh it within 10 minutes.
 *
 *   npx tsx scripts/suppress.ts add entity:CO:20231234567
 *   npx tsx scripts/suppress.ts add "agent:Jane Doe"
 *   npx tsx scripts/suppress.ts remove entity:CO:20231234567
 *   npx tsx scripts/suppress.ts list
 */
import { Redis } from "@upstash/redis";
import { config } from "../src/config.js";
import { parseSuppressions, suppressionKey } from "../src/states/suppression.js";

const [cmd, entry] = process.argv.slice(2);
const c = config();
if (!c.upstashUrl || !c.upstashToken) {
  console.error("Set UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN).");
  process.exit(2);
}
const redis = new Redis({ url: c.upstashUrl, token: c.upstashToken, automaticDeserialization: false });
const key = suppressionKey();
if (cmd === "list") console.log((await redis.smembers(key)).join("\n") || "(empty)");
else if ((cmd === "add" || cmd === "remove") && entry) {
  const p = parseSuppressions([entry]);
  if (!p.entities.size && !p.agentNames.size) {
    console.error('Entry must look like "entity:<STATE>:<id>" or "agent:<name>".');
    process.exit(2);
  }
  console.log(cmd === "add" ? await redis.sadd(key, entry) : await redis.srem(key, entry));
} else {
  console.error("Usage: suppress.ts add|remove <entry> | list");
  process.exit(2);
}
