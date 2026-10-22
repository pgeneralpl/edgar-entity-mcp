/**
 * Live smoke test: spawns the built stdio server (dist/stdio.js) through the official MCP
 * client SDK and calls every tool against real SEC + state data, asserting sanity.
 *   npm run build && npm run smoke
 * Writes full outputs to smoke-output/ for inspection.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdirSync, writeFileSync } from "node:fs";
import { call, check, failed, snip, type Json } from "./lib.js";

if (!process.env.SEC_USER_AGENT) {
  console.error('Set SEC_USER_AGENT="<Your Name> <email>" to run the live smoke test (the SEC requires it).');
  process.exit(2);
}
const out = "smoke-output";
mkdirSync(out, { recursive: true });
const save = (name: string, v: unknown) => writeFileSync(`${out}/${name}.json`, JSON.stringify(v, null, 2));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

console.log("tools/list");
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
check(names.length === 10, `10 tools registered: ${names.join(", ")}`);
const prompts = await client.listPrompts();
check(prompts.prompts.some((p) => p.name === "company_research_brief"), "prompt company_research_brief");
const res = await client.listResources();
check(res.resources.some((r) => r.uri === "edgar-entity://data-sources"), "resource data-sources");

async function t(label: string, name: string, args: Json, asserts: (d: Json) => void) {
  console.log(`\n${label}  ${name} ${JSON.stringify(args)}`);
  const r = await call(client, name, args);
  console.log(`  (${r.ms} ms, ${r.chars} chars${r.isError ? ", isError" : ""})`);
  save(label, r.data);
  try {
    asserts(r.data);
  } catch (e) {
    check(false, `assertion threw: ${(e as Error).message}`);
  }
  console.log("  sample:", snip(r.data, 500));
  return r.data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const any = (x: unknown) => x as any;

await t("01_search_aapl", "search_company", { query: "AAPL" }, (d) => {
  const m = any(d.matches)[0]!;
  check(m.cik === "0000320193" && m.score === 100, "AAPL -> CIK 0000320193, score 100");
});
await t("02_search_fuzzy", "search_company", { query: "berkshire hathaway", limit: 3 }, (d) => {
  check(any(d.matches).some((m) => m.cik === "0001067983"), "fuzzy 'berkshire hathaway' finds CIK 1067983");
});
await t("03_profile_msft", "get_company_profile", { company: "MSFT" }, (d) => {
  check(d.name === "MICROSOFT CORP", "name MICROSOFT CORP");
  check(d.state_of_incorporation === "WA", "incorporated WA");
  check(String(d.fiscal_year_end).includes("0630"), "FYE June 30");
  check(d.sic === "7372", "SIC 7372");
  check(typeof d.ein === "string", "EIN present");
});
await t("04_filings_aapl_10k", "list_filings", { company: "AAPL", forms: ["10-K"], limit: 3 }, (d) => {
  const f = any(d.filings);
  check(f.length === 3 && f.every((x) => String(x.form).startsWith("10-K")), "3 10-K filings");
  check(String(f[0]!.url).startsWith("https://www.sec.gov/Archives/edgar/data/320193/"), "primary doc URL");
});
await t("05_filings_old_history", "list_filings", { company: "AAPL", forms: ["10-K"], date_to: "2010-12-31", limit: 2 }, (d) => {
  const f = any(d.filings);
  check(f.length === 2 && String(f[0]!.filed) <= "2010-12-31", "older-history pagination returns pre-2011 10-Ks");
});
const tenK = await call(client, "list_filings", { company: "AAPL", forms: ["10-K"], limit: 1 });
const tenKUrl = String(any(tenK.data.filings)[0]!.url);
await t("06_doc_section_1a", "get_filing_document", { url: tenKUrl, section: "1A", max_chars: 3000 }, (d) => {
  check(/Risk Factors/i.test(String(d.text).slice(0, 200)), "section 1A starts with Risk Factors");
  check(Number(d.total_chars) > 20000, "1A is substantial (>20k chars)");
  check(typeof d.next_offset === "number", "paging next_offset");
});
await t("07_doc_by_accession", "get_filing_document", { company: "AAPL", accession: String(any(tenK.data.filings)[0]!.accession), max_chars: 1500 }, (d) => {
  check(Array.isArray(d.sections_found) && any(d.sections_found).includes("7"), "sections_found includes 7");
  check(/FORM 10-K/i.test(String(d.text)), "text contains FORM 10-K");
});
await t("08_financials_aapl_annual", "get_financials", { company: "AAPL", limit: 3 }, (d) => {
  const p = any(d.periods);
  check(p.length === 3, "3 annual periods");
  check(Number(p[0]!.revenue) > 300e9, "AAPL revenue > $300B");
  check(Number(p[0]!.eps_diluted) > 3, "EPS diluted sensible");
  check(any(d.tags_used).revenue !== undefined, "tags_used.revenue reported");
  const fys = p.map((x) => x.fy);
  check(new Set(fys).size === fys.length, "fiscal years unique (deduped)");
});
await t("09_financials_msft_quarterly", "get_financials", { company: "MSFT", period_type: "quarterly", limit: 5 }, (d) => {
  const p = any(d.periods);
  check(p.length === 5, "5 quarters");
  check(p.every((x) => Number(x.revenue) > 40e9 && Number(x.revenue) < 150e9), "MSFT quarterly revenue in plausible range");
  check(p.some((x) => x.fp === "Q4"), "includes a derived Q4");
});
await t("10_xbrl_concept", "get_xbrl_concept", { company: "TSLA", tag: "ResearchAndDevelopmentExpense", forms: ["10-K"], framed_only: true, limit: 4 }, (d) => {
  const f = any(d.facts);
  check(f.length === 4 && f.every((x) => x.form === "10-K" && x.frame), "4 framed 10-K facts");
});
await t("11_compare_frames", "compare_companies", { tag: "Revenues", period: "CY2023", companies: ["TSLA", "F", "GM"] }, (d) => {
  const r = any(d.results);
  check(r.length >= 2, "at least 2 automakers in frame");
});
await t("12_compare_top", "compare_companies", { tag: "Assets", period: "CY2024Q4I", limit: 5 }, (d) => {
  const r = any(d.results);
  check(r.length === 5 && Number(r[0]!.val) > 1e12, "top-5 by assets, #1 > $1T");
});
await t("13_insider_tsla", "get_insider_trades", { company: "TSLA", limit: 5 }, (d) => {
  const f = any(d.filings);
  check(f.length > 0, "TSLA has Form 4 filings");
  const tx = f.flatMap((x) => any(x.transactions));
  check(tx.length > 0 && tx.every((x) => typeof x.code === "string"), "transactions parsed with codes");
  check(f.every((x) => typeof x.reporter === "string"), "reporter names present");
});
await t("14_insider_aapl_ps", "get_insider_trades", { company: "AAPL", limit: 10, transaction_codes: ["S", "P"] }, (d) => {
  check(typeof any(d.summary).open_market_sales === "object", "summary present");
});
await t("15_entity_ny", "lookup_business_entity", { name: "Tiffany and Company", states: ["NY"], match: "exact" }, (d) => {
  const r = any(d.results);
  check(r.some((x) => x.entity_id === "22220" && x.formed === "1868-05-30"), "NY DOS ID 22220 Tiffany and Company (1868)");
});
await t("16_entity_co", "lookup_business_entity", { name: "Newmont Corporation", states: ["CO"] }, (d) => {
  const r = any(d.results);
  check(r.some((x) => /Newmont Corporation/i.test(String(x.name)) && x.status), "CO Newmont Corporation with status");
});
await t("17_entity_multi", "lookup_business_entity", { name: "Nike, Inc.", states: ["OR", "CT", "PA"], match: "exact", limit: 2 }, (d) => {
  const r = any(d.results);
  check(r.some((x) => x.state === "OR" && x.entity_id === "8739914"), "OR registry 8739914 NIKE, INC.");
  check(Object.keys(any(d.by_state)).length === 3, "per-state status for 3 states");
});
await t("18_entity_id", "lookup_business_entity", { entity_id: "0783036", states: ["CT"] }, (d) => {
  check(any(d.results)[0]?.name === "THE TRAVELERS COMPANIES, INC.", "CT account 0783036 -> Travelers");
});
await t("19_states", "list_supported_states", {}, (d) => {
  check(any(d.supported).length === 5, "5 supported states");
});
await t("20_error_handling", "get_company_profile", { company: "ZZZZNOTREAL" }, (d) => {
  check(typeof any(d.error).code === "string", `graceful error: ${any(d.error).code}`);
});
await t("21_error_bad_section", "get_filing_document", { url: tenKUrl, section: "99" }, (d) => {
  check(any(d.error).code === "NOT_FOUND", "missing section -> NOT_FOUND with hint");
});

await client.close();
const f = failed();
console.log(`\n${f === 0 ? "ALL SMOKE CHECKS PASSED" : `${f} CHECK(S) FAILED`}`);
process.exit(f === 0 ? 0 : 1);
