import { describe, expect, it } from "vitest";
import { STATE_SOURCES, joinAddr } from "../src/states/registry.js";
import { buildQueryUrl, buildWhere, cleanNameQuery, rankEntities, rowSourceUrl, soqlString } from "../src/states/socrata.js";

const src = (c: string) => STATE_SOURCES[c]!;
const url = (c: string) => (id: string) => rowSourceUrl(src(c), id);

describe("SoQL building", () => {
  it("escapes quotes and strips wildcards", () => {
    expect(soqlString("O'Reilly")).toBe("'O''Reilly'");
    expect(cleanNameQuery("ac%me_ co")).toBe("AC ME CO");
  });
  it("builds where clauses per match mode", () => {
    expect(buildWhere(src("CO"), { name: "Newmont", mode: "contains" })).toBe("upper(entityname) like '%NEWMONT%'");
    expect(buildWhere(src("NY"), { name: "Tiffany", mode: "starts_with" })).toBe("starts_with(upper(current_entity_name), 'TIFFANY')");
    expect(buildWhere(src("CT"), { entityId: "0783036", name: "x y", mode: "exact" })).toBe("accountnumber = '0783036' AND upper(name) = 'X Y'");
    expect(buildWhere(src("CO"), { name: "a b", mode: "exact", activeOnly: true })).toMatch(/^entitystatus in \(/);
  });
  it("groups PA rows to de-duplicate officers", () => {
    const u = new URL(buildQueryUrl(src("PA"), "x", 10));
    expect(u.searchParams.get("$group")).toContain("filing_number");
    expect(u.searchParams.get("$select")).not.toContain("last_name");
  });
});

describe("state normalizers", () => {
  it("NY", () => {
    const [e] = src("NY").normalize(
      [
        {
          dos_id: "22220",
          current_entity_name: "TIFFANY AND COMPANY",
          initial_dos_filing_date: "1868-05-30T00:00:00.000",
          county: "New York",
          jurisdiction: "New York",
          entity_type: "DOMESTIC BUSINESS CORPORATION",
          dos_process_name: "C/O C T CORPORATION SYSTEM",
          dos_process_address_1: "28 LIBERTY STREET",
          dos_process_city: "NEW YORK",
          dos_process_state: "NY",
          dos_process_zip: "10005",
        },
      ],
      url("NY"),
    );
    expect(e).toMatchObject({ state: "NY", entity_id: "22220", status: "Active", formed: "1868-05-30" });
    expect(e!.source_url).toBe("https://data.ny.gov/resource/n9v6-gdp6.json?dos_id=22220");
  });
  it("CO maps entity type codes and agent", () => {
    const [e] = src("CO").normalize(
      [{ entityid: "20021056790", entityname: "Newmont Corporation", entitystatus: "Good Standing", entitytype: "FPC", jurisdictonofformation: "DE", agentorganizationname: "CSC", entityformdate: "2002-03-08T00:00:00.000" }],
      url("CO"),
    );
    expect(e).toMatchObject({ type: "Foreign Profit Corporation (FPC)", status: "Good Standing", registered_agent: { name: "CSC" }, jurisdiction: "DE" });
  });
  it("OR groups row-per-associated-name", () => {
    const base = { registry_number: "8739914", business_name: "NIKE, INC.", entity_type: "DOMESTIC BUSINESS CORPORATION", registry_date: "1969-09-08T00:00:00.000", jurisdiction: "OR" };
    const out = src("OR").normalize(
      [
        { ...base, associated_name_type: "PRINCIPAL PLACE OF BUSINESS", address: "ONE BOWERMAN DRIVE", city: "BEAVERTON", state: "OR", zip: "97005" },
        { ...base, associated_name_type: "REGISTERED AGENT", entity_of_record_name: "UNITED AGENT GROUP INC.", address: "7185 SW SANDBURG ST", city: "PORTLAND", state: "OR", zip: "97223" },
      ],
      url("OR"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ principal_address: "ONE BOWERMAN DRIVE, BEAVERTON, OR, 97005", registered_agent: { name: "UNITED AGENT GROUP INC." } });
  });
  it("CT drops placeholder values and 0001 dates", () => {
    const [e] = src("CT").normalize(
      [{ accountnumber: "1", name: "X LLC", status: "Active", billingstreet: "No information provided", date_registration: "0001-01-01T00:00:00.000", mailing_address: ", , , , ," }],
      url("CT"),
    );
    expect(e!.principal_address).toBeUndefined();
    expect(e!.formed).toBeUndefined();
    expect(e!.mailing_address).toBeUndefined();
  });
  it("PA marks domestic/foreign jurisdiction", () => {
    const [e] = src("PA").normalize([{ filing_number: "0000159516", business_name: "The Hershey Company", typeofbusinessregistration: "Foreign Business Corporation" }], url("PA"));
    expect(e!.jurisdiction).toBe("Foreign (non-PA)");
  });
  it("ranks exact matches first", () => {
    const r = rankEntities(
      [
        { state: "CT", entity_id: "2", name: "TRAVELERS COMPANIES FOUNDATION, INC.", source_url: "" },
        { state: "CT", entity_id: "1", name: "THE TRAVELERS COMPANIES, INC.", source_url: "" },
      ],
      "Travelers Companies",
    );
    expect(r[0]!.entity_id).toBe("1");
  });
  it("joinAddr", () => {
    expect(joinAddr("1 Main", null, "Town", "", "CO")).toBe("1 Main, Town, CO");
    expect(joinAddr(null, undefined)).toBeUndefined();
  });
});
