/** Normalized SchoolInfo detail — server-only.
 *
 * Confirmed product apiTypes: 0 / 09 / 22 / 35 / 55 / 59.
 * apiType 09 = 학년별·학급별 학생수 → core students/classes (never 진학/특목).
 * apiType 52 middle (13-다) = STRUCTURALLY_CONFIRMED category bindings.
 * apiType 52 high = STRUCTURALLY_CONFIRMED career leaves (TOTAL5+6→국외진학).
 *
 * UI hierarchy (middle/high): 기본정보 → 학교 현황 → 진학(·진로) 현황 → 학교생활
 */

export type SectionStatus = "ok" | "missing" | "error" | "auth_hold";

export type Metric = {
  label: string;
  value: string | null;
  raw: number | string | null;
  sourceField?: string;
  derived?: boolean;
};

/**
 * Meaning-based advancement payload — UI must never see TOTAL3/TOTAL4 etc.
 */
export type AdvancementCategory = {
  key: string;
  label: string;
  count: number | null;
  percent: number | null;
};

export type AdvancementData = {
  year: string | null;
  graduates: Metric | null;
  categories: AdvancementCategory[];
  /**
   * full_structurally_confirmed = all product-visible leaves bound.
   * partial = subset only (hidden leaves must not be implied as full graduate set).
   */
  completeness: "full_structurally_confirmed" | "partial";
};

export type SchoolDetail = {
  schoolCode: string;
  neisCode: string | null;
  schoolInfoCode: string | null;
  sameCode: boolean;
  mapping: "same_code" | "runtime_source_link" | "unresolved";
  name: string;
  kind: string | null;
  foundation: string | null;
  /** 남녀공학 / 남학교 / 여학교 — SchoolInfo COEDU when present. */
  coedu: string | null;
  address: string | null;
  tel: string | null;
  homepage: string | null;
  office: string | null;
  foundedOn: string | null;
  core: {
    students: Metric | null;
    classes: Metric | null;
    classSize: Metric | null;
    teachers: Metric | null;
    studentsPerTeacher: Metric | null;
  };
  /** Middle-school 진학현황 (apiType52). High-school career stays null while HOLD. */
  advancement: AdvancementData | null;
  schoolLife: {
    mealPerStudent: Metric | null;
    afterSchoolPrograms: Metric | null;
  };
  scholarship: {
    total: Metric | null;
    perStudent: Metric | null;
  } | null;
  referenceYears: string[];
  sectionStatus: {
    basic: SectionStatus;
    students: SectionStatus;
    teachers: SectionStatus;
    meal: SectionStatus;
    afterSchool: SectionStatus;
    scholarship: SectionStatus;
    advancement: SectionStatus;
  };
  auth: {
    keyPresent: boolean;
    called: boolean;
    httpOk: boolean | null;
    resultCode: string | null;
  };
  attribution: string;
};
