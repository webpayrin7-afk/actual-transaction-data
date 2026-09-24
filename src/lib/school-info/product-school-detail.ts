/**
 * Product-facing school detail — strips internal source metadata
 * before RSC/client serialization.
 *
 * See docs/architecture/data-source-exposure-policy.md
 */

import type {
  AdvancementData,
  Metric,
  SchoolDetail,
} from "@/lib/school-info/types";

export type ProductMetric = {
  label: string;
  value: string | null;
  raw: number | string | null;
  derived?: boolean;
};

export type ProductSchoolDetail = Omit<
  SchoolDetail,
  | "neisCode"
  | "schoolInfoCode"
  | "sameCode"
  | "mapping"
  | "referenceYears"
  | "auth"
  | "sectionStatus"
  | "core"
  | "advancement"
  | "schoolLife"
  | "scholarship"
> & {
  /** True when disclosure cannot load due to missing server credentials. */
  authHold: boolean;
  unresolved: boolean;
  basicError: boolean;
  core: {
    students: ProductMetric | null;
    classes: ProductMetric | null;
    classSize: ProductMetric | null;
    teachers: ProductMetric | null;
    studentsPerTeacher: ProductMetric | null;
  };
  advancement: ProductAdvancementData | null;
  schoolLife: {
    mealPerStudent: ProductMetric | null;
    afterSchoolPrograms: ProductMetric | null;
  };
  scholarship: {
    total: ProductMetric | null;
    perStudent: ProductMetric | null;
  } | null;
};

export type ProductAdvancementData = {
  year: string | null;
  graduates: ProductMetric | null;
  categories: AdvancementData["categories"];
  /** Product-facing completeness only — no internal confidence jargon. */
  completeness: "full" | "partial";
};

function toProductMetric(m: Metric | null): ProductMetric | null {
  if (!m) return null;
  return {
    label: m.label,
    value: m.value,
    raw: m.raw,
    ...(m.derived ? { derived: true } : {}),
  };
}

function toProductAdvancement(
  data: AdvancementData | null,
): ProductAdvancementData | null {
  if (!data) return null;
  return {
    year: data.year,
    graduates: toProductMetric(data.graduates),
    categories: data.categories.map((c) => ({
      key: c.key,
      label: c.label,
      count: c.count,
      percent: c.percent,
    })),
    completeness:
      data.completeness === "partial" ? "partial" : "full",
  };
}

/** Map internal SchoolDetail → product payload for UI. */
export function toProductSchoolDetail(detail: SchoolDetail): ProductSchoolDetail {
  return {
    schoolCode: detail.schoolCode,
    schoolInfoUrl: detail.schoolInfoUrl,
    name: detail.name,
    kind: detail.kind,
    foundation: detail.foundation,
    coedu: detail.coedu,
    address: detail.address,
    tel: detail.tel,
    homepage: detail.homepage,
    office: detail.office,
    foundedOn: detail.foundedOn,
    core: {
      students: toProductMetric(detail.core.students),
      classes: toProductMetric(detail.core.classes),
      classSize: toProductMetric(detail.core.classSize),
      teachers: toProductMetric(detail.core.teachers),
      studentsPerTeacher: toProductMetric(detail.core.studentsPerTeacher),
    },
    advancement: toProductAdvancement(detail.advancement),
    schoolLife: {
      mealPerStudent: toProductMetric(detail.schoolLife.mealPerStudent),
      afterSchoolPrograms: toProductMetric(
        detail.schoolLife.afterSchoolPrograms,
      ),
    },
    scholarship: detail.scholarship
      ? {
          total: toProductMetric(detail.scholarship.total),
          perStudent: toProductMetric(detail.scholarship.perStudent),
        }
      : null,
    attribution: detail.attribution,
    authHold: !detail.auth.keyPresent,
    unresolved:
      detail.mapping === "unresolved" && !detail.schoolInfoCode,
    basicError:
      detail.sectionStatus.basic === "error" && !detail.schoolInfoCode,
  };
}
