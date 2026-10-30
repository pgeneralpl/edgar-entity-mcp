/**
 * Small curated list of well-known former names / predecessor names of SEC registrants, matched by
 * search_company without any SEC call. Each entry maps to the CIK of the *current* registrant; an
 * entry whose CIK is no longer in the SEC ticker list is ignored at runtime.
 *
 * Kept deliberately short (no network fetch, no cache use). The authoritative former-name history is
 * in get_company_profile (EDGAR submissions `formerNames`) and EDGAR company search.
 */
export interface FormerName {
  name: string;
  cik: number;
  /** "former_name": a formerNames entry of the same CIK; "predecessor": a different (older) registrant or brand. */
  kind: "former_name" | "predecessor";
}

export const FORMER_NAMES: readonly FormerName[] = [
  { name: "Apple Computer Inc", cik: 320193, kind: "former_name" },
  { name: "Facebook Inc", cik: 1326801, kind: "former_name" },
  { name: "Google Inc", cik: 1652044, kind: "predecessor" },
  { name: "Philip Morris Companies Inc", cik: 764180, kind: "former_name" },
  { name: "Wal-Mart Stores Inc", cik: 104169, kind: "former_name" },
  { name: "United Technologies Corp", cik: 101829, kind: "former_name" },
  { name: "Raytheon Technologies Corp", cik: 101829, kind: "former_name" },
  { name: "Square Inc", cik: 1512673, kind: "former_name" },
  { name: "FDX Corp", cik: 1048911, kind: "former_name" },
  { name: "Hewlett-Packard Co", cik: 47217, kind: "former_name" },
  { name: "SBC Communications Inc", cik: 732717, kind: "former_name" },
  { name: "Bell Atlantic Corp", cik: 732712, kind: "former_name" },
  { name: "Salesforce.com Inc", cik: 1108524, kind: "former_name" },
  { name: "Discovery Inc", cik: 1437107, kind: "former_name" },
  { name: "Priceline Group Inc", cik: 1075531, kind: "former_name" },
  { name: "Priceline.com Inc", cik: 1075531, kind: "former_name" },
  { name: "Kraft Foods Inc", cik: 1103982, kind: "former_name" },
  { name: "CenturyLink Inc", cik: 18926, kind: "former_name" },
  { name: "Anthem Inc", cik: 1156039, kind: "former_name" },
  { name: "WellPoint Inc", cik: 1156039, kind: "former_name" },
  { name: "Polo Ralph Lauren Corp", cik: 1037038, kind: "former_name" },
  { name: "Tricon Global Restaurants Inc", cik: 1041061, kind: "former_name" },
  { name: "Coach Inc", cik: 1116132, kind: "former_name" },
  { name: "Federated Department Stores Inc", cik: 794367, kind: "former_name" },
  { name: "CVS Caremark Corp", cik: 64803, kind: "former_name" },
  { name: "Minnesota Mining & Manufacturing Co", cik: 66740, kind: "former_name" },
];
