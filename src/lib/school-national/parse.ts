/**
 * SchoolInfo row parsers.
 * Field bindings match the verified school-detail adapter
 * (apiType 0 / 09 / 22 / 35 / 55 / 59, openData apiType 52).
 * Absent numbers stay null. Never coerce a missing count to 0.
 */

import {
  HIGH_GRADUATES_BINDING,
  visibleHighCareerBindings,
} from "@/lib/school-national/high-career-mapping";
import {
  MIDDLE_GRADUATES_BINDING,
  visibleMiddleBindings,
} from "@/lib/school-national/middle-advancement-mapping";

export const SCHOOLINFO_ATTRIBUTION = "출처: 학교알리미";
export const SCHOOLINFO_LICENSE =
  "공공데이터포털 학교알리미 공시정보 OpenAPI · 공공저작물 제3유형(출처표시·변경금지)";

export type SchoolLevel = "elementary" | "middle" | "high";

export type CategoryStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "NO_DATA"
  | "NOT_APPLICABLE"
  | "FAILED";

export type Metric = {
  label: string;
  value: string | null;
  raw: number | string | null;
  sourceField?: string;
  derived?: boolean;
};

export type GraduateCategory = {
  key: string;
  label: string;
  count: number | null;
  percent: number | null;
  sourceField: string;
};

export function asString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s && s !== "-" && s !== "null" && s !== "undefined") return s;
  }
  return null;
}

export function asNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Number(String(v).replace(/,/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function countStr(n: number, unit: string): string {
  return `${n.toLocaleString("ko-KR")}${unit}`;
}

function decimalStr(n: number, unit: string): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`;
}

function wonStr(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원`;
}

export function metric(
  label: string,
  raw: number | string | null,
  display: string | null,
  opts?: { sourceField?: string; derived?: boolean },
): Metric | null {
  if (display == null || raw == null || raw === "") return null;
  return {
    label,
    value: display,
    raw,
    sourceField: opts?.sourceField,
    derived: opts?.derived,
  };
}

export function schoolCodeOf(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  return asString(row.SCHUL_CODE);
}

export function levelFromKindCode(code: string | null | undefined): SchoolLevel | null {
  if (code === "02") return "elementary";
  if (code === "03") return "middle";
  if (code === "04") return "high";
  return null;
}

/** SchoolInfo COEDU_SC_CODE. 남/여 match the verified parser; 녀 is the live female token. */
export function genderTypeOf(raw: unknown): string | null {
  const coeduRaw = asString(raw);
  if (!coeduRaw) return null;
  if (coeduRaw === "남") return "남학교";
  if (coeduRaw === "여" || coeduRaw === "녀") return "여학교";
  return coeduRaw;
}

export function regionOf(adrcdNm: unknown, fallback?: { sido: string; sigungu: string }): {
  sido: string | null;
  sigungu: string | null;
} {
  const name = asString(adrcdNm);
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return { sido: parts[0]!, sigungu: parts.slice(1).join(" ") };
    }
  }
  return {
    sido: fallback?.sido ?? null,
    sigungu: fallback?.sigungu ?? null,
  };
}

export function roadAddressOf(row: Record<string, unknown>): string | null {
  const road = [asString(row.SCHUL_RDNMA), asString(row.SCHUL_RDNDA)]
    .filter(Boolean)
    .join(" ");
  return road || null;
}

export function parcelAddressOf(row: Record<string, unknown>): string | null {
  return asString(row.ADRES_BRKDN, row.DTLAD_BRKDN);
}

const KOREA_LAT = { min: 33, max: 39.5 };
const KOREA_LNG = { min: 124, max: 132.5 };

export function koreaCoord(row: Record<string, unknown>): { lat: number | null; lng: number | null } {
  const lat = asNumber(row.LTTUD);
  const lng = asNumber(row.LGTUD);
  if (lat == null || lng == null) return { lat: null, lng: null };
  if (lat === 0 && lng === 0) return { lat: null, lng: null };
  if (lat < KOREA_LAT.min || lat > KOREA_LAT.max) return { lat: null, lng: null };
  if (lng < KOREA_LNG.min || lng > KOREA_LNG.max) return { lat: null, lng: null };
  return { lat, lng };
}

export function operatingStatus(row: Record<string, unknown>): "operating" | "closed" {
  return asString(row.CLOSE_YN) === "Y" ? "closed" : "operating";
}

export type BasicParsed = {
  schoolCode: string | null;
  name: string | null;
  level: SchoolLevel | null;
  establishmentType: string | null;
  genderType: string | null;
  sido: string | null;
  sigungu: string | null;
  address: string | null;
  roadAddress: string | null;
  lat: number | null;
  lng: number | null;
  status: "operating" | "closed";
  tel: string | null;
  homepage: string | null;
  office: string | null;
  foundedOn: string | null;
};

export function parseBasic(
  row: Record<string, unknown> | null,
  fallbackRegion?: { sido: string; sigungu: string },
): BasicParsed | null {
  if (!row) return null;
  const region = regionOf(row.ADRCD_NM, fallbackRegion);
  const foundedRaw = asString(row.FOAS_MEMRD, row.FOND_YMD);
  let foundedOn: string | null = foundedRaw;
  if (foundedRaw) {
    const d = foundedRaw.replace(/\D/g, "");
    if (d.length === 8) foundedOn = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
  }
  const coord = koreaCoord(row);
  const kindCode = asString(row.SCHUL_KND_SC_CODE);
  return {
    schoolCode: schoolCodeOf(row),
    name: asString(row.SCHUL_NM),
    level: levelFromKindCode(kindCode),
    establishmentType: asString(row.FOND_SC_CODE, row.FOND_SC_NM),
    genderType: genderTypeOf(row.COEDU_SC_CODE),
    sido: region.sido,
    sigungu: region.sigungu,
    address: parcelAddressOf(row),
    roadAddress: roadAddressOf(row),
    lat: coord.lat,
    lng: coord.lng,
    status: operatingStatus(row),
    tel: asString(row.USER_TELNO),
    homepage: asString(row.HMPG_ADRES),
    office: asString(row.ATPT_OFCDC_ORG_NM, row.JU_ORG_NM),
    foundedOn,
  };
}

export function basicCategoryStatus(parsed: BasicParsed | null): CategoryStatus {
  if (!parsed?.schoolCode || !parsed.name || !parsed.level) return "NO_DATA";
  return "COMPLETE";
}

export type StudentParsed = {
  students: Metric | null;
  classes: Metric | null;
  classSize: Metric | null;
  teachersOnStudentFeed: Metric | null;
  studentsPerTeacher: Metric | null;
};

export function parseStudents(row: Record<string, unknown> | null): StudentParsed | null {
  if (!row) return null;
  const studentsN = asNumber(row.COL_S_SUM, row.COL_SUM_S2, row.STDNT_CNT, row.TOT_STDNT_CNT);
  const classesN = asNumber(row.COL_C_SUM, row.COL_SUM_C2, row.CLAS_CNT, row.TOT_CLAS_CNT);
  const classSizeOfficial = asNumber(row.COL_SUM, row.COL_SUM_2, row.AVG_STDNT_CNT);
  const teachersN = asNumber(row.TEACH_CNT, row.TCH_CNT, row.TOT_TCH_CNT);
  const sptOfficial = asNumber(row.TEACH_CAL, row.STDNT_PER_TCH);

  let classSize = metric(
    "학급당 학생수",
    classSizeOfficial,
    classSizeOfficial != null ? decimalStr(classSizeOfficial, "명") : null,
    { sourceField: "COL_SUM" },
  );
  if (!classSize && studentsN != null && classesN != null && classesN > 0) {
    const d = studentsN / classesN;
    classSize = metric("학급당 학생수", d, decimalStr(d, "명"), {
      derived: true,
      sourceField: "students/classes",
    });
  }

  let studentsPerTeacher = metric(
    "교원 1인당 학생수",
    sptOfficial,
    sptOfficial != null ? decimalStr(sptOfficial, "명") : null,
    { sourceField: "TEACH_CAL" },
  );
  if (!studentsPerTeacher && studentsN != null && teachersN != null && teachersN > 0) {
    const d = studentsN / teachersN;
    studentsPerTeacher = metric("교원 1인당 학생수", d, decimalStr(d, "명"), {
      derived: true,
      sourceField: "students/teachers",
    });
  }

  return {
    students: metric("학생수", studentsN, studentsN != null ? countStr(studentsN, "명") : null, {
      sourceField: "COL_S_SUM",
    }),
    classes: metric("학급수", classesN, classesN != null ? countStr(classesN, "학급") : null, {
      sourceField: "COL_C_SUM",
    }),
    classSize,
    teachersOnStudentFeed: metric(
      "교원수",
      teachersN,
      teachersN != null ? countStr(teachersN, "명") : null,
      { sourceField: "TEACH_CNT" },
    ),
    studentsPerTeacher,
  };
}

export function studentCategoryStatus(parsed: StudentParsed | null): CategoryStatus {
  if (!parsed) return "NO_DATA";
  if (parsed.students && parsed.classes) return "COMPLETE";
  if (parsed.students || parsed.classes) return "PARTIAL";
  return "NO_DATA";
}

export function parseTeachers(row: Record<string, unknown> | null): { teachers: Metric | null } | null {
  if (!row) return null;
  const n = asNumber(row.COL_S, row.TOT_TCH_CNT, row.TEACH_CNT);
  return {
    teachers: metric("교원수", n, n != null ? countStr(n, "명") : null, { sourceField: "COL_S" }),
  };
}

export function teacherCategoryStatus(parsed: { teachers: Metric | null } | null): CategoryStatus {
  if (!parsed?.teachers) return "NO_DATA";
  return "COMPLETE";
}

export function parseMeal(row: Record<string, unknown> | null): { meal: Metric | null } | null {
  if (!row) return null;
  const n = asNumber(row.STDNT_ONE_PSNBY_LM, row.ONE_PSNBY_MLSV_CT, row.MLSV_ONE_PSNBY_AMT);
  return {
    meal: metric("급식비(1식)", n, n != null ? `${wonStr(n)} / 1인` : null, {
      sourceField: "STDNT_ONE_PSNBY_LM",
    }),
  };
}

export function mealCategoryStatus(parsed: { meal: Metric | null } | null): CategoryStatus {
  if (!parsed?.meal) return "NO_DATA";
  return "COMPLETE";
}

export function parseAfterSchool(row: Record<string, unknown> | null): { programs: Metric | null } | null {
  if (!row) return null;
  const n = asNumber(row.SUM_ASL_PGM_FGR, row.ASL_PGM_CNT, row.AFSC_PGM_CNT, row.TOT_PGM_CNT);
  return {
    programs: metric("방과후학교 프로그램", n, n != null ? countStr(n, "개") : null, {
      sourceField: "SUM_ASL_PGM_FGR",
    }),
  };
}

export function afterSchoolCategoryStatus(parsed: { programs: Metric | null } | null): CategoryStatus {
  if (!parsed?.programs) return "NO_DATA";
  return "COMPLETE";
}

export function parseScholarship(
  row: Record<string, unknown> | null,
  studentCount: number | null,
): { total: Metric | null; perStudent: Metric | null } | null {
  if (!row) return null;
  const totalN = asNumber(row.SCHO_AMT, row.TOT_SCHO_AMT, row.SCHOLARSHIP_AMT);
  const total = metric("총 장학금", totalN, totalN != null ? wonStr(totalN) : null, {
    sourceField: "SCHO_AMT",
  });
  let perStudent: Metric | null = null;
  if (totalN != null && studentCount != null && studentCount > 0) {
    const d = totalN / studentCount;
    perStudent = metric("학생 1인당", d, wonStr(d), {
      derived: true,
      sourceField: "SCHO_AMT / students",
    });
  }
  return { total, perStudent };
}

export function scholarshipCategoryStatus(
  parsed: { total: Metric | null } | null,
  applicability: "applies" | "not_applicable",
): CategoryStatus {
  if (applicability === "not_applicable") return "NOT_APPLICABLE";
  if (!parsed?.total) return "NO_DATA";
  return "COMPLETE";
}

export type GraduateParsed = {
  graduates: Metric | null;
  categories: GraduateCategory[];
  completeness: "full_structurally_confirmed" | "partial";
};

function percentFor(
  row: Record<string, unknown>,
  count: number | null,
  graduates: number | null,
  rateFields: string[],
): number | null {
  if (count == null) return null;
  for (const field of rateFields) {
    const official = asNumber(row[field]);
    if (official != null) return official;
  }
  if (graduates != null && graduates > 0) {
    return Math.round((1000 * count) / graduates) / 10;
  }
  return null;
}

export function parseMiddleGraduate(row: Record<string, unknown> | null): GraduateParsed | null {
  if (!row) return null;
  const graduatesRaw = asNumber(row[MIDDLE_GRADUATES_BINDING.field]);
  const graduates =
    graduatesRaw != null
      ? metric("졸업생", graduatesRaw, countStr(graduatesRaw, "명"), {
          sourceField: MIDDLE_GRADUATES_BINDING.field,
        })
      : null;
  const bindings = visibleMiddleBindings();
  const categories: GraduateCategory[] = bindings.map((b) => {
    const count = asNumber(row[b.field]);
    return {
      key: b.key,
      label: b.label,
      count,
      percent: percentFor(row, count, graduatesRaw, [`TOTAL_RATE${b.field.replace("TOTAL", "")}`]),
      sourceField: b.field,
    };
  });
  const present = categories.filter((c) => c.count != null);
  if (!graduates && present.length === 0) return null;
  const completeness =
    graduates && categories.every((c) => c.count != null)
      ? "full_structurally_confirmed"
      : "partial";
  return { graduates, categories: present, completeness };
}

export function parseHighGraduate(row: Record<string, unknown> | null): GraduateParsed | null {
  if (!row) return null;
  const graduatesRaw = asNumber(row[HIGH_GRADUATES_BINDING.field]);
  const graduates =
    graduatesRaw != null
      ? metric("졸업생", graduatesRaw, countStr(graduatesRaw, "명"), {
          sourceField: HIGH_GRADUATES_BINDING.field,
        })
      : null;
  const categories: GraduateCategory[] = visibleHighCareerBindings().map((b) => {
    const parts = b.fields.map((field) => asNumber(row[field]));
    const count = parts.every((v) => v != null) ? parts.reduce((sum, v) => sum! + v!, 0) : null;
    const rateFields =
      b.key === "overseas"
        ? ["OUT_TOT_SUM_RATE"]
        : b.fields.length === 1
          ? [`TOTAL_RATE${b.fields[0]!.replace("TOTAL", "")}`]
          : [];
    return {
      key: b.key,
      label: b.label,
      count,
      percent: percentFor(row, count, graduatesRaw, rateFields),
      sourceField: b.fields.join("+"),
    };
  });
  const present = categories.filter((c) => c.count != null);
  if (!graduates && present.length === 0) return null;
  const completeness =
    graduates && categories.every((c) => c.count != null)
      ? "full_structurally_confirmed"
      : "partial";
  return { graduates, categories: present, completeness };
}

export function graduateCategoryStatus(
  level: SchoolLevel,
  parsed: GraduateParsed | null,
): CategoryStatus {
  if (level === "elementary") return "NOT_APPLICABLE";
  if (!parsed?.graduates) return parsed ? "PARTIAL" : "NO_DATA";
  if (parsed.completeness !== "full_structurally_confirmed") return "PARTIAL";
  return "COMPLETE";
}

export function isDatasetAbsent(resultCode: string | null, resultMsg: string | null): boolean {
  const code = (resultCode ?? "").toLowerCase();
  const msg = resultMsg ?? "";
  if (code === "success" || code === "info-000") return false;
  return msg.includes("데이터가 존재하지 않습니다") || msg.includes("데이터 없음");
}

/** Verified NEIS SD_SCHUL_CODE links. Never extended by name match. */
export const VERIFIED_NEIS_LINKS: Readonly<Record<string, string>> = {
  S010000944: "7130153",
  S010000888: "7130202",
  S010000887: "7130201",
  S010000523: "7010107",
  S010000522: "7010106",
  S010000496: "7010712",
};

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Product nearby radius. Straight line from the complex parcel point, not a building. */
export const NEARBY_RADIUS_M = 1500;
export const DISTANCE_BASIS = "PARCEL_REPRESENTATIVE_POINT" as const;
export const NEARBY_CLASSIFICATION = "NEARBY_SCHOOL" as const;
