/**
 * Live check against a deployed Streamable HTTP endpoint.
 * Usage: npx tsx scripts/e2e-remote.ts [https://edgar-entity-mcp.vercel.app/mcp]
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call, check, failed, snip } from "./lib.js";

const url = process.argv[2] ?? process.env.MCP_REMOTE_URL ?? "https://edgar-entity-mcp.vercel.app/mcp";
const headers: Record<string, string> = process.env.MCP_API_KEY ? { authorization: `Bearer ${process.env.MCP_API_KEY}` } : {};
console.log(`remote e2e → ${url}`);

const client = new Client({ name: "e2e-remote", version: "0.0.0" });
const t0 = Date.now();
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
console.log(`  connected in ${Date.now() - t0} ms`);

const tools = await client.listTools();
check(tools.tools.length === 10, `tools/list → ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON predicates
const cases: [string, Record<string, unknown>, (d: Record<string, any>) => boolean][] = [
  ["search_company", { query: "AAPL", limit: 1 }, (d) => d.matches?.[0]?.cik === "0000320193"],
  ["get_financials", { company: "AAPL", period_type: "annual", limit: 2 }, (d) => Array.isArray(d.periods) && d.periods.length > 0],
  ["get_insider_trades", { company: "TSLA", limit: 5 }, (d) => Array.isArray(d.filings) && d.filings.length > 0 && !!d.summary],
  ["lookup_business_entity", { name: "Newmont Corporation", states: ["CO"] }, (d) => JSON.stringify(d).includes("20021056790")],
];
for (const [name, args, ok] of cases) {
  const r = await call(client, name, args);
  check(!r.isError && ok(r.data), `${name} ${JSON.stringify(args)} → ${r.ms} ms, ${r.chars} chars`);
  console.log(`    ${snip(r.data, 400)}`);
}
await client.close();
if (failed()) {
  console.log(`REMOTE CHECKS FAILED: ${failed()}`);
  process.exit(1);
}
console.log("ALL REMOTE CHECKS PASSED");
