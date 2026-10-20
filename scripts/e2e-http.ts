/**
 * E2E test of the Streamable HTTP entrypoint: starts the local node server (same handler
 * as the Vercel function), connects with the official SDK client, lists and calls tools,
 * then verifies API-key gating with MCP_API_KEYS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { call, check, failed, snip } from "./lib.js";

async function start(port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["dist/http/node-server.js"], { env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000);
    p.stderr!.on("data", (d: Buffer) => {
      if (String(d).includes("HTTP MCP endpoint")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return p;
}

const port = 3917;
console.log("Open endpoint");
let srv = await start(port);
try {
  const health = await (await fetch(`http://localhost:${port}/health`)).json();
  check((health as { name: string }).name === "edgar-entity-mcp", "health endpoint");
  const client = new Client({ name: "e2e-http", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
  const tools = await client.listTools();
  check(tools.tools.length === 10, `tools/list over HTTP: ${tools.tools.length} tools`);
  const r = await call(client, "search_company", { query: "NVDA", limit: 1 });
  check((r.data.matches as { cik: string }[])[0]?.cik === "0001045810", "search_company NVDA over HTTP");
  console.log("  sample:", snip(r.data, 300));
  const f = await call(client, "get_financials", { company: "NVDA", limit: 2, metrics: ["revenue", "net_income"] });
  check(Array.isArray(f.data.periods) && (f.data.periods as unknown[]).length === 2, "get_financials over HTTP");
  console.log("  sample:", snip(f.data, 400));
  await client.close();

  // Raw legacy-era JSON-RPC (2025-06-18 initialize) to confirm backwards-compatible serving.
  const init = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
  });
  const body = await init.text();
  check(init.ok && body.includes("edgar-entity-mcp"), `legacy 2025-06-18 initialize accepted (HTTP ${init.status})`);
} finally {
  srv.kill();
}

console.log("\nAPI-key gated endpoint (MCP_API_KEYS=test-key-123)");
srv = await start(port + 1, { MCP_API_KEYS: "test-key-123" });
try {
  const noKey = await fetch(`http://localhost:${port + 1}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check(noKey.status === 401, `no key -> 401 (got ${noKey.status})`);
  const client = new Client({ name: "e2e-http-key", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${port + 1}/mcp`), { requestInit: { headers: { "x-api-key": "test-key-123" } } }),
  );
  const tools = await client.listTools();
  check(tools.tools.length === 10, "x-api-key accepted");
  await client.close();
} finally {
  srv.kill();
}

const n = failed();
console.log(n ? `\n${n} HTTP CHECK(S) FAILED` : "\nALL HTTP CHECKS PASSED");
process.exit(n ? 1 : 0);
