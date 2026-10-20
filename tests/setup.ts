import { beforeEach } from "vitest";
import { clearRedisDegraded } from "../src/core/degraded.js";
import { memoryFallbackStore } from "../src/core/quota.js";

// Degraded mode and the in-memory fallback quota store are process-wide; isolate tests.
beforeEach(() => {
  clearRedisDegraded();
  (memoryFallbackStore() as unknown as { counts: Map<string, unknown> }).counts.clear();
});
