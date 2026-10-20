import { describe, expect, it, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer, runTool } from "../src/server.js";
import { ALL_TOOLS } from "../src/tools.js";
import { setUsageHooks } from "../src/core/usage.js";

afterEach(() => setUsageHooks({}));

describe("MCP server wiring (in-memory, no network)", () => {
  it("lists tools, prompt and resource; list_supported_states works offline", async () => {
    const server = createServer("stdio");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b as never);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    for (const t of tools.tools) {
      expect(t.description!.length).toBeGreaterThan(60);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    const r = (await client.callTool({ name: "list_supported_states", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text).supported.map((s: { code: string }) => s.code)).toEqual(["NY", "CO", "OR", "CT", "PA"]);
    const p = await client.getPrompt({ name: "company_research_brief", arguments: { company: "AAPL" } });
    expect(JSON.stringify(p.messages)).toContain("get_financials");
    const res = await client.readResource({ uri: "edgar-entity://data-sources" });
    expect(JSON.stringify(res.contents)).toContain("OPEN-NY");
    await client.close();
  });

  it("usage hooks can reject and meter calls", async () => {
    const seen: string[] = [];
    setUsageHooks({
      beforeCall: (e) => {
        if (e.tool === "list_supported_states" && !e.apiKey) throw new Error("API key required");
      },
      afterCall: (e) => void seen.push(`${e.tool}:${e.ok}:${e.errorCode ?? ""}`),
    });
    const def = ALL_TOOLS.find((t) => t.name === "list_supported_states")!;
    const r = await runTool(def, {}, "http");
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content[0] as { text: string }).text).error.code).toBe("UNAUTHORIZED");
    expect(seen).toEqual(["list_supported_states:false:UNAUTHORIZED"]);
  });

  it("validation errors are graceful", async () => {
    const def = ALL_TOOLS.find((t) => t.name === "lookup_business_entity")!;
    const r = await runTool(def, { states: ["NY"], match: "contains", limit: 5, active_only: false }, "stdio");
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("INVALID_INPUT");
  });
});
