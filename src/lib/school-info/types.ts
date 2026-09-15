/** Normalized SchoolInfo detail — server-only. */

export type SectionStatus = "ok" | "missing" | "error" | "auth_hold";

export type Metric = {
  label: string;
  value: string | null;
  raw: number | string | null;
  sourceField?: string;
  derived?: boolean;
};

export type AdvancementBucket = {
  label: string;
  count: number | null;
  percent: number | null;
};

export type SchoolDetail = {
  schoolCode: string;
  neisCode: string | null;
  schoolInfoCode: string | null;
  sameCode: boolean;
  mapping: "same_code" | "runtime_name_region" | "unresolved";
  name: string;
  kind: string | null;
  foundation: string | null;
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
  advancement: {
    graduates: Metric | null;
    buckets: AdvancementBucket[];
  } | null;
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
    advancement: SectionStatus;
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
