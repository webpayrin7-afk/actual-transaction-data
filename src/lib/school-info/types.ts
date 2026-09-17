/** Normalized SchoolInfo detail — server-only.
 *
 * Confirmed product apiTypes: 0 / 09 / 22 / 35 / 55 / 59.
 * apiType 09 = 학년별·학급별 학생수 → core students/classes (never 진학/특목).
 * apiType 52 (13-다 졸업생 진로) = HOLD_UNCONFIRMED_FIELD_MAPPING — omitted from detail.
 */

export type SectionStatus = "ok" | "missing" | "error" | "auth_hold";

export type Metric = {
  label: string;
  value: string | null;
  raw: number | string | null;
  sourceField?: string;
  derived?: boolean;
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
  };
  auth: {
    keyPresent: boolean;
    called: boolean;
    httpOk: boolean | null;
    resultCode: string | null;
  };
  attribution: string;
};
