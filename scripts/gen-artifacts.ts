/** Regenerates docs/artifacts derived from code: DATA_SOURCES.md, static server card, MCPB manifest tool list. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ALL_TOOLS } from "../src/tools.js";
import { DATA_SOURCES_MD } from "../src/dataSources.js";
import { PACKAGE_NAME, VERSION } from "../src/version.js";

writeFileSync("DATA_SOURCES.md", DATA_SOURCES_MD + "\n");

const card = {
  serverInfo: { name: PACKAGE_NAME, version: VERSION },
  authentication: { required: false },
  tools: ALL_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }) })),
  resources: [{ uri: "edgar-entity://data-sources", name: "data-sources", mimeType: "text/markdown" }],
  prompts: [{ name: "company_research_brief", arguments: [{ name: "company", required: true }, { name: "focus", required: false }] }],
};
mkdirSync("public/.well-known/mcp", { recursive: true });
writeFileSync("public/.well-known/mcp/server-card.json", JSON.stringify(card, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = VERSION;
manifest.tools = ALL_TOOLS.map((t) => ({ name: t.name, description: t.description.split(". ")[0]!.slice(0, 200) }));
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const sj = JSON.parse(readFileSync("server.json", "utf8"));
sj.version = VERSION;
for (const p of sj.packages ?? []) p.version = VERSION;
writeFileSync("server.json", JSON.stringify(sj, null, 2) + "\n");
console.log("generated DATA_SOURCES.md, public/.well-known/mcp/server-card.json, manifest.json, server.json");
