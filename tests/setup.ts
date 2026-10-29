import { beforeEach } from "vitest";
import { clearRedisDegraded } from "../src/core/degraded.js";
import { resetCacheWriteState } from "../src/core/cache.js";
import { resetStats } from "../src/core/stats.js";
import { memoryFallbackStore, resetMinuteCounters } from "../src/core/quota.js";

// Degraded mode and the in-memory fallback quota store are process-wide; isolate tests.
beforeEach(() => {
  clearRedisDegraded();
  (memoryFallbackStore() as unknown as { counts: Map<string, unknown> }).counts.clear();
  resetMinuteCounters();
  resetCacheWriteState();
  // Usage stats are on by default in production; off here so exact command-count tests stay exact.
  resetStats({ enabled: false });
});
