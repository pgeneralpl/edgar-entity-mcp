/** Invokes the Vercel function module (api/mcp.ts) directly with Web Requests. */
import { POST } from "../api/mcp.js";
import { check, failed } from "./lib.js";

const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (id: number, method: string, params: unknown = {}) =>
  POST(new Request("https://example.vercel.app/mcp", { method: "POST", headers: hdr, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));

const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fn", version: "1" } });
check(init.status === 200, `initialize -> ${init.status}`);
const list = await rpc(2, "tools/list");
const text = await list.text();
check(text.includes("lookup_business_entity"), "tools/list via Vercel function module");
const callRes = await rpc(3, "tools/call", { name: "search_company", arguments: { query: "TSLA", limit: 1 } });
const ct = await callRes.text();
check(ct.includes("0001318605"), "tools/call search_company TSLA via Vercel function module");
console.log(failed() ? "VERCEL FN CHECKS FAILED" : "ALL VERCEL FN CHECKS PASSED");
process.exit(failed() ? 1 : 0);
