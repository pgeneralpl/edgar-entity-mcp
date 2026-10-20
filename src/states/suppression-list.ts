/**
 * Built-in suppression list for personal-data erasure / objection requests.
 * Entries:
 *   "entity:<STATE>:<entity_id>"  remove agent, service-of-process and address fields for that entity
 *   "agent:<NAME>"                withhold this agent name (case/spacing-insensitive) everywhere, even with include_agent_details
 * Operators can add entries without a release via the Redis set `<CACHE_PREFIX>suppress`
 * (see scripts/suppress.ts) or a JSON file array at SUPPRESSION_FILE.
 */
export const BUILTIN_SUPPRESSIONS: string[] = [];
