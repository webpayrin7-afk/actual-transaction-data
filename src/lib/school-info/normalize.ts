/** Parse SchoolInfo rows into metrics.
 *
 * apiType map used by school detail:
 * - 0  학교기본정보 → parseBasic
 * - 09 학년별·학급별 학생수 → parseStudentsTeachers (NOT 진학/특목)
 * - 22 직위별 교원 현황 → parseTeacherHeadcount
 * - 35 급식비 집행 실적 → parseMeal
 * - 55 장학금 수혜 현황 → parseScholarship
 * - 59 방과후학교 → parseAfterSchool
 *
 * apiType 52 middle (13-다) → parseMiddleAdvancement via STRUCTURALLY_CONFIRMED map.
 * apiType 52 high (13-다) → parseHighSchoolCareer via STRUCTURALLY_CONFIRMED map.
 */

import {
  HIGH_GRADUATES_BINDING,
  visibleHighCareerBindings,
} from "@/lib/school-info/high-school-career-mapping";
import {
  MIDDLE_GRADUATES_BINDING,
  visibleMiddleBindings,
} from "@/lib/school-info/middle-advancement-mapping";
import type {
  AdvancementData,
  Metric,
  SectionStatus,
} from "@/lib/school-info/types";

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

export function yearOf(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  return asString(row.PBAN_YR, row.pbanYr, row.BASE_YR, row.SURVEY_YR);
}

export function parseStudentsTeachers(row: Record<string, unknown> | null): {
  students: Metric | null;
  classes: Metric | null;
  classSize: Metric | null;
  teachers: Metric | null;
  studentsPerTeacher: Metric | null;
  year: string | null;
  status: SectionStatus;
} {
  if (!row) {
    return {
      students: null,
      classes: null,
      classSize: null,
      teachers: null,
      studentsPerTeacher: null,
      year: null,
      status: "missing",
    };
  }

  const studentsN = asNumber(
    row.COL_SUM_S2,
    row.COL_S_SUM,
    row.STDNT_CNT,
    row.TOT_STDNT_CNT,
  );
  const classesN = asNumber(
    row.COL_SUM_C2,
    row.COL_C_SUM,
    row.CLAS_CNT,
    row.TOT_CLAS_CNT,
  );
  const classSizeOfficial = asNumber(row.COL_SUM_2, row.COL_SUM, row.AVG_STDNT_CNT);
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

  const students = metric(
    "학생수",
    studentsN,
    studentsN != null ? countStr(studentsN, "명") : null,
    { sourceField: "COL_S_SUM" },
  );
  const classes = metric(
    "학급수",
    classesN,
    classesN != null ? countStr(classesN, "학급") : null,
    { sourceField: "COL_C_SUM" },
  );
  const teachers = metric(
    "교원수",
    teachersN,
    teachersN != null ? countStr(teachersN, "명") : null,
    { sourceField: "TEACH_CNT" },
  );

  return {
    students,
    classes,
    classSize,
    teachers,
    studentsPerTeacher,
    year: yearOf(row),
    status: students || classes || teachers ? "ok" : "missing",
  };
}

export function parseTeacherHeadcount(row: Record<string, unknown> | null): {
  teachers: Metric | null;
  year: string | null;
} {
  if (!row) return { teachers: null, year: null };
  const n = asNumber(row.COL_S, row.TOT_TCH_CNT, row.TEACH_CNT);
  return {
    teachers: metric("교원수", n, n != null ? countStr(n, "명") : null, {
      sourceField: "COL_S",
    }),
    year: yearOf(row),
  };
}

export function parseMeal(row: Record<string, unknown> | null): {
  meal: Metric | null;
  year: string | null;
  status: SectionStatus;
} {
  if (!row) return { meal: null, year: null, status: "missing" };
  const n = asNumber(
    row.STDNT_ONE_PSNBY_LM,
    row.ONE_PSNBY_MLSV_CT,
    row.MLSV_ONE_PSNBY_AMT,
  );
  // apiType 35 depthNo=20: 학생 1인당 1식 기준 식품비 (2023+); older years: 1인당 급식비.
  const meal = metric(
    "급식비(1식)",
    n,
    n != null ? `${wonStr(n)} / 1인` : null,
    { sourceField: "STDNT_ONE_PSNBY_LM" },
  );
  return { meal, year: yearOf(row), status: meal ? "ok" : "missing" };
}

export function parseAfterSchool(row: Record<string, unknown> | null): {
  programs: Metric | null;
  year: string | null;
  status: SectionStatus;
} {
  if (!row) return { programs: null, year: null, status: "missing" };
  const n = asNumber(
    row.SUM_ASL_PGM_FGR,
    row.ASL_PGM_CNT,
    row.AFSC_PGM_CNT,
    row.TOT_PGM_CNT,
  );
  const programs = metric(
    "방과후학교 프로그램",
    n,
    n != null ? countStr(n, "개") : null,
    { sourceField: "SUM_ASL_PGM_FGR" },
  );
  return { programs, year: yearOf(row), status: programs ? "ok" : "missing" };
}

export function parseScholarship(
  row: Record<string, unknown> | null,
  studentCount: number | null,
): {
  total: Metric | null;
  perStudent: Metric | null;
  year: string | null;
  status: SectionStatus;
} {
  if (!row) {
    return { total: null, perStudent: null, year: null, status: "missing" };
  }
  const totalN = asNumber(row.SCHO_AMT, row.TOT_SCHO_AMT, row.SCHOLARSHIP_AMT);
  const total = metric(
    "총 장학금",
    totalN,
    totalN != null ? wonStr(totalN) : null,
    { sourceField: "SCHO_AMT" },
  );
  let perStudent: Metric | null = null;
  if (totalN != null && studentCount != null && studentCount > 0) {
    const d = totalN / studentCount;
    perStudent = metric("학생 1인당", d, wonStr(d), {
      derived: true,
      sourceField: "SCHO_AMT / students",
    });
  }
  return {
    total,
    perStudent,
    year: yearOf(row),
    status: total ? "ok" : "missing",
  };
}

/**
 * apiType 0 — 학교기본정보.
 * Do not use apiType 09 rows here; 09 is students/classes only.
 */
export function parseBasic(row: Record<string, unknown> | null): {
  name: string | null;
  kind: string | null;
  foundation: string | null;
  coedu: string | null;
  address: string | null;
  tel: string | null;
  homepage: string | null;
  office: string | null;
  foundedOn: string | null;
  schoolInfoCode: string | null;
  /** Public page UUID (학교알리미 SHL_IDF_CD). */
  shlIdfCd: string | null;
  year: string | null;
} {
  if (!row) {
    return {
      name: null,
      kind: null,
      foundation: null,
      coedu: null,
      address: null,
      tel: null,
      homepage: null,
      office: null,
      foundedOn: null,
      schoolInfoCode: null,
      shlIdfCd: null,
      year: null,
    };
  }

  const road = [asString(row.SCHUL_RDNMA), asString(row.SCHUL_RDNDA)]
    .filter(Boolean)
    .join(" ");

  const foundedRaw = asString(
    row.FOAS_MEMRD,
    row.FOND_YMD,
    row.FOUNDED_YMD,
    row.OPEN_YMD,
  );
  let foundedOn: string | null = foundedRaw;
  if (foundedRaw) {
    const d = foundedRaw.replace(/\D/g, "");
    if (d.length === 8) {
      foundedOn = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
    }
  }

  const kindFromCode = (() => {
    const code = asString(row.SCHUL_KND_SC_CODE, row.SCHUL_KND_CODE);
    if (code === "02") return "초등학교";
    if (code === "03") return "중학교";
    if (code === "04") return "고등학교";
    if (code === "05") return "특수학교";
    return null;
  })();

  const coeduRaw = asString(row.COEDU_SC_NM, row.COEDU_SC_CODE);
  const coedu =
    coeduRaw === "남"
      ? "남학교"
      : coeduRaw === "여"
        ? "여학교"
        : coeduRaw;

  return {
    name: asString(row.SCHUL_NM),
    kind:
      kindFromCode ||
      asString(
        row.SCHUL_CRSE_SC_VALUE_NM,
        row.SCHUL_KND_SC_NM,
        row.SCHUL_KND_NM,
      ),
    foundation: asString(row.FOND_SC_NM, row.FOUND_SC_NM, row.FOND_SC_CODE),
    // SchoolInfo often stores the label in COEDU_SC_CODE (e.g. 남녀공학).
    coedu,
    address: asString(road || null, row.SCHUL_RDNMA, row.ADRES_BRKDN, row.ORG_RDNMA),
    tel: asString(row.USER_TELNO, row.ORG_TELNO, row.TELNO),
    homepage: asString(row.HMPG_ADRES, row.HMPG_URL, row.HOMEPAGE),
    office: asString(
      row.ATPT_OFCDC_ORG_NM,
      row.JU_ORG_NM,
      row.ATPT_OFCDC_SC_NM,
    ),
    foundedOn,
    schoolInfoCode: asString(row.SCHUL_CODE, row.SD_SCHUL_CODE),
    shlIdfCd: asString(row.SHL_IDF_CD),
    year: yearOf(row),
  };
}

export function attribution(years: string[]): string {
  const uniq = [...new Set(years.filter(Boolean))];
  // 학교알리미 attribution retained (공공저작물 출처표시 의무 — do not remove).
  if (uniq.length === 1) return `${uniq[0]}년 공시 · 학교알리미`;
  if (uniq.length > 1) {
    return `공시자료 기준 (항목별 연도 상이) · 학교알리미`;
  }
  return "학교알리미 공시 기준";
}

/**
 * Middle-school openData apiType52 row → AdvancementData.
 * Uses STRUCTURALLY_CONFIRMED bindings only; never exposes raw TOTAL* to UI.
 */
export function parseMiddleAdvancement(
  row: Record<string, unknown> | null,
  pbanYear: number | null,
): {
  status: SectionStatus;
  data: AdvancementData | null;
} {
  if (!row) return { status: "missing", data: null };

  const graduatesRaw = asNumber(row[MIDDLE_GRADUATES_BINDING.field]);
  const graduates =
    graduatesRaw != null
      ? metric(
          "졸업생",
          graduatesRaw,
          countStr(graduatesRaw, "명"),
          { sourceField: MIDDLE_GRADUATES_BINDING.field },
        )
      : null;

  const categories = visibleMiddleBindings()
    .map((b) => {
      const count = asNumber(row[b.field]);
      const rateField = `TOTAL_RATE${b.field.replace("TOTAL", "")}`;
      let percent = asNumber(row[rateField]);
      if (
        percent == null &&
        count != null &&
        graduatesRaw != null &&
        graduatesRaw > 0
      ) {
        percent = Math.round((1000 * count) / graduatesRaw) / 10;
      }
      return {
        key: b.key,
        label: b.label,
        count,
        percent,
      };
    })
    .filter((c) => c.count != null);

  if (!graduates && categories.length === 0) {
    return { status: "missing", data: null };
  }

  return {
    status: "ok",
    data: {
      year: pbanYear != null ? String(pbanYear) : yearOf(row),
      graduates,
      categories,
      completeness: "full_structurally_confirmed",
    },
  };
}

/**
 * High-school openData apiType52 row → AdvancementData (career leaves).
 * Separate adapter from middle — never reuses TOTAL3–14 middle bindings.
 * 국외진학 = TOTAL5+TOTAL6 (official single leaf).
 */
export function parseHighSchoolCareer(
  row: Record<string, unknown> | null,
  pbanYear: number | null,
): {
  status: SectionStatus;
  data: AdvancementData | null;
} {
  if (!row) return { status: "missing", data: null };

  const graduatesRaw = asNumber(row[HIGH_GRADUATES_BINDING.field]);
  const graduates =
    graduatesRaw != null
      ? metric("졸업생", graduatesRaw, countStr(graduatesRaw, "명"), {
          sourceField: HIGH_GRADUATES_BINDING.field,
        })
      : null;

  const categories = visibleHighCareerBindings()
    .map((b) => {
      const count = b.fields.reduce((sum, f) => {
        const v = asNumber(row[f]);
        return sum + (v ?? 0);
      }, 0);
      // Prefer OUT rate for overseas; else derive from graduates.
      let percent: number | null = null;
      if (b.key === "overseas") {
        percent = asNumber(row.OUT_TOT_SUM_RATE);
      } else if (b.fields.length === 1) {
        const rateField = `TOTAL_RATE${b.fields[0]!.replace("TOTAL", "")}`;
        percent = asNumber(row[rateField]);
      }
      if (
        percent == null &&
        graduatesRaw != null &&
        graduatesRaw > 0
      ) {
        percent = Math.round((1000 * count) / graduatesRaw) / 10;
      }
      return {
        key: b.key,
        label: b.label,
        count,
        percent,
      };
    })
    .filter((c) => c.count != null);

  if (!graduates && categories.length === 0) {
    return { status: "missing", data: null };
  }

  return {
    status: "ok",
    data: {
      year: pbanYear != null ? String(pbanYear) : yearOf(row),
      graduates,
      categories,
      completeness: "full_structurally_confirmed",
    },
  };
}
