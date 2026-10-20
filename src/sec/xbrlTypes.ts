export interface Fact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
  frame?: string;
}

export interface ConceptFacts {
  label?: string | null;
  description?: string | null;
  units: Record<string, Fact[]>;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, ConceptFacts>>;
}
