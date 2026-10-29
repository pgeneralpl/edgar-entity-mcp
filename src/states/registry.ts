import { compact, isoDate } from "../core/util.js";

export interface NormalizedEntity {
  state: string;
  entity_id: string;
  name: string;
  status?: string;
  type?: string;
  formed?: string;
  jurisdiction?: string;
  /** NY: name on the principal location (can be a person). Withheld with the addresses when personal. */
  location_name?: string;
  principal_address?: string;
  mailing_address?: string;
  registered_agent?: AgentInfo;
  /** NY: the person/company designated by the DOS to receive service of process. */
  service_of_process?: AgentInfo;
  /** True when addresses were withheld because a related party (agent/process contact) is an individual. */
  addresses_withheld?: boolean;
  /** Set when personal data was removed because of an erasure/suppression request. */
  redacted?: string;
  county?: string;
  naics?: string;
  details_url?: string;
  source_url: string;
}

export interface AgentInfo {
  name?: string;
  address?: string;
  /** "organization" (commercial agent / company) or "individual" (a natural person). */
  kind?: "organization" | "individual";
  /** True when an individual's name/address was withheld (pass include_agent_details=true to see it). */
  withheld?: boolean;
}

type Row = Record<string, unknown>;

/**
 * Conservative heuristic, defaulting to "individual" (withheld). When in doubt, a name is treated
 * as a person (fail closed). A name counts as an organization only if:
 * - it matches a known commercial registered-agent service; or
 * - it ends with a punctuated single-letter entity suffix ("L.P.", "L.L.C.", "N.A." …) preceded
 *   by a real word ("N.A." additionally needs BANK/TRUST in the name); or
 * - it does NOT end in one or two single-letter tokens (initials: "SMITH JOHN L P",
 *   "GARCIA MARIA N A" are people) and ends with an unambiguous legal-form suffix; or
 * - it ends with a weak word such as "BANK" and also contains another organization word
 *   ("FIRST NATIONAL BANK" yes, "AARON BANK" no).
 * Ambiguous endings are treated as individuals on purpose: "CO" ("DAVID CO"), "PA"/"PC"
 * (professional associations of one person, and surnames), "LAW", "CHURCH", "GROUP", "TRUST".
 * The classification is automated and can miss; the suppression list covers the rest.
 */
const ORG_SUFFIX_RE =
  /(?:^|\s)(INC|INCORPORATED|CORP|CORPORATION|LLC|L L C|LLP|L L P|LLLP|L L L P|PLLC|P L L C|LP|LTD|LIMITED|COMPANY|(?:&|AND) CO|ASSOCIATION|FOUNDATION|UNIVERSITY)$/;
/** Words that are also surnames; they mark an organization only together with another org word. */
const WEAK_ORG_END_RE = /(?:^|\s)BANK(?: NA)?$/;
const ORG_WORD_RE =
  /\b(?:NATIONAL|FEDERAL|SAVINGS|TRUST|FIRST|CITIZENS|COMMUNITY|STATE|UNITED|AMERICAN?|FINANCIAL|COMMERCE|COMMERCIAL|MERCHANTS|CREDIT|UNION|PEOPLES|FARMERS|SECURITY|CAPITAL|CHASE|HOLDINGS|BANCORP|CORPORATE)\b/;
/** Punctuated single-letter suffix at the end ("L.P.", "N.A.", "L.L.C."), preceded by a word of 2+ letters. */
const PUNCT_SUFFIX_RE = /([A-Za-z]{2,})[\s,]+((?:[A-Za-z]\.\s?){2,})$/;
const PUNCT_ENTITY_SUFFIXES = new Set(["LP", "LLC", "LLP", "LLLP", "PLLC", "NA"]);
/** Exactly one or two single-letter tokens at the end, after a longer token. */
const TRAILING_INITIALS_RE = /(?:^|\s)\S{2,}(?: [A-Z]){1,2}$/;
const KNOWN_AGENT_SERVICES_RE =
  /^(?:THE )?(?:C ?T CORPORATION SYSTEM|CORPORATION SERVICE COMPANY|CSC[- ]LAWYERS INCORPORATING SERVICE|NATIONAL REGISTERED AGENTS|NORTHWEST REGISTERED AGENT|REGISTERED AGENTS? (?:INC|LEGAL SERVICES|SOLUTIONS)|COGENCY GLOBAL|INCORP SERVICES|UNITED STATES CORPORATION AGENTS|CORPORATION TRUST COMPANY|LEGALINC CORPORATE SERVICES|BUSINESS FILINGS INCORPORATED|HARBOR COMPLIANCE|CAPITOL SERVICES|A REGISTERED AGENT)\b/;

export function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/[^A-Z0-9& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeOrganization(name: string | undefined): boolean {
  if (!name) return false;
  const n = normalizeName(name);
  if (KNOWN_AGENT_SERVICES_RE.test(n)) return true;
  const raw = name.trim();
  const m = PUNCT_SUFFIX_RE.exec(raw);
  if (m) {
    const suffix = m[2]!.replace(/[.\s]/g, "").toUpperCase();
    if (PUNCT_ENTITY_SUFFIXES.has(suffix)) {
      if (suffix !== "NA") return true;
      return /\b(?:BANK|TRUST)\b/.test(normalizeName(raw.slice(0, m.index + m[1]!.length)));
    }
  }
  // Ends in one or two initials ("L P", "N A"): a person unless proven otherwise above.
  if (TRAILING_INITIALS_RE.test(n)) return false;
  if (ORG_SUFFIX_RE.test(n)) return true;
  if (WEAK_ORG_END_RE.test(n)) return ORG_WORD_RE.test(n.replace(WEAK_ORG_END_RE, ""));
  return false;
}

/** Build an AgentInfo, classifying it when the source does not say. */
export function agent(name: string | undefined, address: string | undefined, kind?: "organization" | "individual"): AgentInfo | undefined {
  if (!name && !address) return undefined;
  // Default to individual. A source hint of "individual" always wins; otherwise "organization"
  // requires the conservative name heuristic (even in "organization name" columns, which are
  // free text and sometimes hold a person's name).
  const k = kind === "individual" ? "individual" : looksLikeOrganization(name) ? "organization" : "individual";
  return compact({ name, address, kind: k }) as AgentInfo;
}

export interface StateSource {
  code: string;
  state: string;
  domain: string;
  dataset: string;
  dataset_name: string;
  landing_url: string;
  /** Column used for name search. */
  nameField: string;
  /** Column used for entity id lookup. */
  idField: string;
  coverage: string;
  license: string;
  license_url: string;
  commercial_use: string;
  attribution?: string;
  notes?: string;
  update_frequency: string;
  /** SoQL $select / $group for de-duplicating row-per-person datasets. */
  select?: string[];
  group?: boolean;
  /** SoQL clause restricting to active/good-standing entities (when the dataset has inactive ones). */
  activeWhere?: string;
  /** One entity can span multiple rows (row-per-associated-name). */
  multiRow?: boolean;
  /** Approximate rows fetched per requested entity for multi-row datasets. */
  rowsPerEntity?: number;
  normalize(rows: Row[], sourceUrl: (id: string) => string): NormalizedEntity[];
}

const PLACEHOLDERS = /^(no information provided|none|n\/a|null|unknown)$/i;
const s = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t && !PLACEHOLDERS.test(t) ? t : undefined;
};

export const CO_ENTITY_TYPES: Record<string, string> = {
  DLLC: "Domestic Limited Liability Company",
  FLLC: "Foreign Limited Liability Company",
  DPC: "Domestic Profit Corporation",
  "DPC-PBC": "Domestic Profit Corporation (Public Benefit)",
  FPC: "Foreign Profit Corporation",
  DNC: "Domestic Nonprofit Corporation",
  FNC: "Foreign Nonprofit Corporation",
  DLP: "Domestic Limited Partnership",
  FLP: "Foreign Limited Partnership",
  DLLP: "Domestic Limited Liability Partnership",
  FLLP: "Foreign Limited Liability Partnership",
  DLLLP: "Domestic Limited Liability Limited Partnership",
  FLLLP: "Foreign Limited Liability Limited Partnership",
  GP: "General Partnership",
  FO: "Foreign Other",
  UNA: "Unincorporated Nonprofit Association",
  DLCA: "Domestic Limited Cooperative Association",
  "DLCA-PBC": "Domestic Limited Cooperative Association (Public Benefit)",
  DLPA: "Domestic Limited Partnership Association",
  FCOOP: "Foreign Cooperative",
  DC55: "Domestic Cooperative (C.R.S. 7-55)",
  DC56: "Domestic Cooperative (C.R.S. 7-56)",
  "DC55-PBC": "Domestic Cooperative (C.R.S. 7-55, Public Benefit)",
  "DC56-PBC": "Domestic Cooperative (C.R.S. 7-56, Public Benefit)",
};

const coType = (code?: string) => (code ? (CO_ENTITY_TYPES[code] ? `${CO_ENTITY_TYPES[code]} (${code})` : code) : undefined);

export function joinAddr(...parts: unknown[]): string | undefined {
  const t = parts.map(s).filter(Boolean) as string[];
  if (!t.length) return undefined;
  return t.join(", ").replace(/,\s*,/g, ",");
}

export const COLORADO_DISCLAIMER =
  "The data made available here has been modified for use from its original source, which is the State of Colorado. THE STATE OF COLORADO MAKES NO REPRESENTATIONS OR WARRANTY AS TO THE COMPLETENESS, ACCURACY, TIMELINESS, OR CONTENT OF ANY DATA MADE AVAILABLE THROUGH THIS SITE. THE STATE OF COLORADO EXPRESSLY DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE. The data is subject to change as modifications and updates are complete. It is understood that the information contained in the Web feed is being used at one's own risk.";

const NY: StateSource = {
  code: "NY",
  state: "New York",
  domain: "data.ny.gov",
  dataset: "n9v6-gdp6",
  dataset_name: "Active Corporations: Beginning 1800 (NYS Department of State, Division of Corporations)",
  landing_url: "https://data.ny.gov/d/n9v6-gdp6",
  nameField: "current_entity_name",
  idField: "dos_id",
  coverage: "ACTIVE entities only (corporations, LLCs, LPs, not-for-profits). Inactive/dissolved entities are not included.",
  license: "OPEN-NY Terms of Use",
  license_url: "https://data.ny.gov/download/77gx-ii52/application/pdf",
  commercial_use: "Permitted. OPEN-NY terms allow any lawful use including commercial; no attribution or share-alike required.",
  attribution: "New York State Department of State",
  update_frequency: "Monthly",
  normalize: (rows, src) =>
    rows.map((r) =>
      compact({
        state: "NY",
        entity_id: s(r.dos_id)!,
        name: s(r.current_entity_name)!,
        status: "Active",
        type: s(r.entity_type),
        formed: isoDate(s(r.initial_dos_filing_date)),
        jurisdiction: s(r.jurisdiction),
        county: s(r.county),
        location_name: s(r.location_name),
        principal_address: joinAddr(r.location_name, r.location_address_1, r.location_address_2, r.location_city, r.location_state, r.location_zip),
        service_of_process: agent(s(r.dos_process_name), joinAddr(r.dos_process_address_1, r.dos_process_address_2, r.dos_process_city, r.dos_process_state, r.dos_process_zip)),
        registered_agent: agent(
          s(r.registered_agent_name),
          joinAddr(r.registered_agent_address_1, r.registered_agent_address_2, r.registered_agent_city, r.registered_agent_state, r.registered_agent_zip),
        ),
        details_url: "https://apps.dos.ny.gov/publicInquiry/",
        source_url: src(s(r.dos_id)!),
      }),
    ),
};

const CO: StateSource = {
  code: "CO",
  state: "Colorado",
  domain: "data.colorado.gov",
  dataset: "4ykn-tg5h",
  dataset_name: "Business Entities in Colorado (Colorado Department of State)",
  landing_url: "https://data.colorado.gov/d/4ykn-tg5h",
  nameField: "entityname",
  idField: "entityid",
  coverage: "All entities incl. dissolved/delinquent (status field), since 1864.",
  license: "Public Domain (dataset metadata) + Colorado Information Marketplace Terms of Service",
  license_url: "https://data.colorado.gov/terms",
  commercial_use:
    "Permitted. Dataset is marked Public Domain. The portal ToS requires applications using the data to display the State of Colorado disclaimer (included in README/DATA_SOURCES and list_supported_states).",
  attribution: "Colorado Department of State (CDOS)",
  notes: "Applications must display the Colorado disclaimer; see DATA_SOURCES.md.",
  update_frequency: "Daily",
  activeWhere: "entitystatus in ('Good Standing','Exists','Delinquent','Noncompliant','Registered Agent Resigned')",
  normalize: (rows, src) =>
    rows.map((r) => {
      const agentOrg = s(r.agentorganizationname);
      const agentName = agentOrg ?? s([r.agentfirstname, r.agentmiddlename, r.agentlastname, r.agentsuffix].map(s).filter(Boolean).join(" "));
      return compact({
        state: "CO",
        entity_id: s(r.entityid)!,
        name: s(r.entityname)!,
        status: s(r.entitystatus),
        type: coType(s(r.entitytype)),
        formed: isoDate(s(r.entityformdate)),
        jurisdiction: s(r.jurisdictonofformation),
        principal_address: joinAddr(r.principaladdress1, r.principaladdress2, r.principalcity, r.principalstate, r.principalzipcode, r.principalcountry),
        mailing_address: joinAddr(r.mailingaddress1, r.mailingaddress2, r.mailingcity, r.mailingstate, r.mailingzipcode, r.mailingcountry),
        registered_agent: agent(
          agentName,
          joinAddr(r.agentprincipaladdress1, r.agentprincipaladdress2, r.agentprincipalcity, r.agentprincipalstate, r.agentprincipalzipcode),
          agentOrg ? undefined : agentName ? "individual" : undefined,
        ),
        details_url: `https://www.coloradosos.gov/biz/BusinessEntityDetail.do?masterFileId=${s(r.entityid)}`,
        source_url: src(s(r.entityid)!),
      });
    }),
};

const OR: StateSource = {
  code: "OR",
  state: "Oregon",
  domain: "data.oregon.gov",
  dataset: "tckn-sxa6",
  dataset_name: "Active Businesses - ALL (Oregon Secretary of State, Corporation Division)",
  landing_url: "https://data.oregon.gov/d/tckn-sxa6",
  nameField: "business_name",
  idField: "registry_number",
  coverage: "ACTIVE businesses only (incl. assumed business names). One row per associated name (address/agent/officer), grouped here by registry number.",
  license: "Public domain by statute (ORS 276A.368(3): 'All publishable data is in the public domain')",
  license_url: "https://oregon.public.law/statutes/ors_276a.368",
  commercial_use: "Permitted. Oregon open-data statute places portal data in the public domain and forbids use restrictions (ORS 276A.356(1)(c)).",
  attribution: "Oregon Secretary of State, Corporation Division",
  update_frequency: "Weekly",
  multiRow: true,
  rowsPerEntity: 5,
  normalize: (rows, src) => {
    const by = new Map<string, Row[]>();
    for (const r of rows) {
      const id = s(r.registry_number);
      if (!id) continue;
      if (!by.has(id)) by.set(id, []);
      by.get(id)!.push(r);
    }
    return [...by.entries()].map(([id, rs]) => {
      const first = rs[0]!;
      const of = (t: string) => rs.find((r) => s(r.associated_name_type)?.toUpperCase() === t);
      const pp = of("PRINCIPAL PLACE OF BUSINESS");
      const ma = of("MAILING ADDRESS");
      const ra = of("REGISTERED AGENT");
      const raOrg = ra ? s(ra.entity_of_record_name) : undefined;
      const raPerson = ra ? s([ra.first_name, ra.middle_name, ra.last_name, ra.suffix].map(s).filter(Boolean).join(" ")) : undefined;
      const raName = raOrg ?? raPerson;
      const det = first.business_details as { url?: string } | undefined;
      return compact({
        state: "OR",
        entity_id: id,
        name: s(first.business_name)!,
        status: "Active",
        type: s(first.entity_type),
        formed: isoDate(s(first.registry_date)),
        jurisdiction: s(first.jurisdiction),
        principal_address: pp ? joinAddr(pp.address, pp.address_continued, pp.city, pp.state, pp.zip) : undefined,
        mailing_address: ma ? joinAddr(ma.address, ma.address_continued, ma.city, ma.state, ma.zip) : undefined,
        registered_agent: ra
          ? agent(raName, joinAddr(ra.address, ra.address_continued, ra.city, ra.state, ra.zip), raPerson && !raOrg ? "individual" : undefined)
          : undefined,
        details_url: det?.url?.replace(/^http:/, "https:"),
        source_url: src(id),
      });
    });
  },
};

const CT: StateSource = {
  code: "CT",
  state: "Connecticut",
  domain: "data.ct.gov",
  dataset: "n7gp-d28j",
  dataset_name: "Connecticut Business Registry - Business Master (Office of the Secretary of the State)",
  landing_url: "https://data.ct.gov/d/n7gp-d28j",
  nameField: "name",
  idField: "accountnumber",
  coverage: "All registered businesses incl. inactive/dissolved/forfeited (status field).",
  license: "Public Domain (dataset metadata); CT Open Data Portal terms",
  license_url: "https://data.ct.gov/terms",
  commercial_use: "Permitted. Dataset is marked Public Domain; CT open data is defined by statute (CGS 4-67o) as having no restrictions governing use.",
  attribution: "Connecticut Office of the Secretary of the State",
  update_frequency: "Daily",
  activeWhere: "status in ('Active','Active - Pending Domestication','Registered','Recorded')",
  normalize: (rows, src) =>
    rows.map((r) =>
      compact({
        state: "CT",
        entity_id: s(r.accountnumber)!,
        name: s(r.name)!,
        status: [s(r.status), s(r.sub_status)].filter(Boolean).join(" - ") || undefined,
        type: [s(r.citizenship), s(r.business_type)].filter(Boolean).join(" ") || undefined,
        formed: isoDate(s(r.date_registration)),
        jurisdiction: s(r.state_or_territory_formation) ?? s(r.formation_place) ?? s(r.country_formation),
        principal_address: joinAddr(r.billingstreet, r.billing_unit, r.billingcity, r.billingstate, r.billingpostalcode),
        mailing_address: s(r.mailing_address)?.replace(/(\s*,\s*)+/g, ", ").replace(/^, |, $/g, "") || undefined,
        naics: s(r.naics_code),
        details_url: "https://service.ct.gov/business/s/onlinebusinesssearch",
        source_url: src(s(r.accountnumber)!),
      }),
    ),
};

const PA_SELECT = ["filing_number", "business_name", "typeofbusinessregistration", "creationdate", "address_line1", "address_line2", "city", "state", "zip", "shortcountyname"];
const PA: StateSource = {
  code: "PA",
  state: "Pennsylvania",
  domain: "data.pa.gov",
  dataset: "xvd7-5r2c",
  dataset_name: "Registered Businesses in PA Current by County (PA Department of State)",
  landing_url: "https://data.pa.gov/d/xvd7-5r2c",
  nameField: "business_name",
  idField: "filing_number",
  coverage: "Currently registered businesses only, with PA address. Row-per-officer in source; de-duplicated here (officer names omitted).",
  license: "Public Domain U.S. Government (dataset metadata)",
  license_url: "https://www.usa.gov/government-works",
  commercial_use: "Permitted. Dataset is marked 'Public Domain U.S. Government' on data.pa.gov.",
  attribution: "Pennsylvania Department of State",
  update_frequency: "Monthly",
  select: PA_SELECT,
  group: true,
  normalize: (rows, src) =>
    rows.map((r) =>
      compact({
        state: "PA",
        entity_id: s(r.filing_number)!,
        name: s(r.business_name)!,
        status: "Active (current registration)",
        type: s(r.typeofbusinessregistration),
        formed: isoDate(s(r.creationdate)),
        jurisdiction: /^foreign/i.test(s(r.typeofbusinessregistration) ?? "") ? "Foreign (non-PA)" : /^domestic/i.test(s(r.typeofbusinessregistration) ?? "") ? "PA" : undefined,
        principal_address: joinAddr(r.address_line1, r.address_line2, r.city, r.state, r.zip),
        county: s(r.shortcountyname),
        details_url: "https://file.dos.pa.gov/search/business",
        source_url: src(s(r.filing_number)!),
      }),
    ),
};

export const STATE_SOURCES: Record<string, StateSource> = { NY, CO, OR, CT, PA };
export const SUPPORTED_STATES = Object.keys(STATE_SOURCES);

/** States investigated but not enabled, with reasons (shown by list_supported_states). */
export const UNSUPPORTED_NOTES: Record<string, string> = {
  DE: "Delaware (most large US corporations) offers no open bulk data; the Division of Corporations search is web-only with paid status/document fees. Roadmap: link-out only.",
  CA: "California bizfile offers a public API (api.sos.ca.gov) requiring registration/subscription key; not an open-license dataset. Roadmap.",
  FL: "Florida Sunbiz publishes bulk data files via SFTP (public records); not a SODA API. Roadmap.",
};
