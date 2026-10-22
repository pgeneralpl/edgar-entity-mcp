#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, warnIfDefaultUserAgent } from "./server.js";
import { config } from "./config.js";
import { setUsageHooks, stderrUsageLogger } from "./core/usage.js";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { isPatchedNode, PATCHED_NODE_TEXT } from "./core/nodeVersion.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  process.stdout.write(`${PACKAGE_NAME} ${VERSION} - MCP server (stdio) for SEC EDGAR + state business-entity data.

Usage: npx -y ${PACKAGE_NAME}

Environment:
  SEC_USER_AGENT            REQUIRED by SEC policy: "<Company/Name> <email>"
  SEC_MAX_RPS               SEC request rate cap (default 6, max 8)
  SOCRATA_APP_TOKEN         Optional Socrata app token for state registries
  UPSTASH_REDIS_REST_URL    Optional shared cache (with UPSTASH_REDIS_REST_TOKEN)
  USAGE_LOG=1               Log per-call usage JSON to stderr

Requires Node.js ${PATCHED_NODE_TEXT}.
`);
  process.exit(0);
}

// Warn (stderr only; stdout is the MCP channel) on Node.js releases without the 2026-10-21 fixes.
if (!isPatchedNode())
  process.stderr.write(
    `[${PACKAGE_NAME}] WARNING: Node.js ${process.version} lacks the October 2026 security fixes (incl. CVE-2026-111497, Brotli decoder RCE reachable via fetch). Upgrade to ${PATCHED_NODE_TEXT}.\n`,
  );
if (config().usageLog) setUsageHooks(stderrUsageLogger);
warnIfDefaultUserAgent();

// serveStdio picks the protocol era from the client's opening message and pins one server instance.
serveStdio(() => createServer("stdio"), {
  onerror: (e) => process.stderr.write(`[${PACKAGE_NAME}] ${e.message}\n`),
});
