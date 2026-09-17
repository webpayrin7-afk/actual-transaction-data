/** Normalized SchoolInfo detail — server-only.
 *
 * Confirmed product apiTypes: 0 / 09 / 22 / 35 / 55 / 59.
 * apiType 09 = 학년별·학급별 학생수 → core students/classes (never 진학/특목).
 * apiType 52 (13-다 졸업생 진로) = HOLD_UNCONFIRMED_FIELD_MAPPING —
 *   AdvancementData slot reserved; no TOTAL* binding until official evidence.
 *
 * UI hierarchy (middle): 학교 현황 → 진학 현황 → 학교생활 → 기본정보
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
 * Only populate after ADVANCEMENT_API52 = PASS with official column binding.
 * Do not invent categories from observational matches.
 */
export type AdvancementCategory = {
  label: string;
  count: number | null;
  percent: number | null;
};

export type AdvancementData = {
  year: string | null;
  graduates: Metric | null;
  categories: AdvancementCategory[];
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
  /**
   * Middle-school 진학현황. Always null while ADVANCEMENT_API52 is HOLD.
   * Never fabricate from apiType09 or guessed TOTAL* maps.
   */
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
    /** HOLD → missing; never ok until official TOTAL binding. */
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
