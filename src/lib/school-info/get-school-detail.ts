/**
 * School detail loader — /school/[schoolCode] only.
 * App route id stays NEIS SD_SCHUL_CODE; SchoolInfo fetch uses resolved SCHUL_CODE.
 */

import {
  fetchApi,
  hasApiKey,
  isSuccess,
  listOf,
  REVALIDATE_SECONDS,
  type ApiType,
} from "@/lib/school-info/client";
import {
  KIND,
  SEOUL_SIDO,
  SONGPA_SGG,
  findKnownLink,
  inferKindFromNameHint,
  pickByCode,
  resolveSchoolInfoCode,
  years,
  type Kind,
  type ResolveMethod,
} from "@/lib/school-info/identity";
import { ADVANCEMENT_API52 } from "@/lib/school-info/advancement-disclosure";
import {
  asNumber,
  attribution,
  parseAfterSchool,
  parseBasic,
  parseMeal,
  parseScholarship,
  parseStudentsTeachers,
  parseTeacherHeadcount,
} from "@/lib/school-info/normalize";
import type { Metric, SchoolDetail, SectionStatus } from "@/lib/school-info/types";

/**
 * ADVANCEMENT_API52 = HOLD_UNCONFIRMED_FIELD_MAPPING.
 * Do not fetch apiType52 or scrape 09/0 into a fake 진학현황 block.
 * Unblock only per advancement-disclosure.ts / mapping report SOT.
 */
void ADVANCEMENT_API52;

export type GetSchoolDetailParams = {
  /** App school id — currently NEIS SD_SCHUL_CODE (e.g. 7130202). */
  schoolCode: string;
  nameHint?: string | null;
  addressHint?: string | null;
  kind?: Kind;
  sidoCode?: string;
  sggCode?: string;
};

type Sec = {
  apiType: ApiType;
  year: number | null;
  status: SectionStatus;
  row: Record<string, unknown> | null;
  resultCode: string | null;
  httpOk: boolean | null;
  called: boolean;
};

/** Detail cache keyed by SchoolInfo SCHUL_CODE — not by school name. */
const detailCache = new Map<
  string,
  { expiresAt: number; value: SchoolDetail }
>();

function schoolInfoDetailCacheKey(
  schoolInfoCode: string,
  appSchoolId: string,
  kind: string,
  sidoCode: string,
  sggCode: string,
): string {
  return `schoolinfo:${schoolInfoCode}:detail:${appSchoolId}:${kind}:${sidoCode}:${sggCode}`;
}

function mappingFromMethod(
  method: ResolveMethod,
): SchoolDetail["mapping"] {
  if (method === "same_code") return "same_code";
  if (method === "known_link" || method === "verified_fields") {
    return "runtime_source_link";
  }
  return "unresolved";
}

async function fetchList(p: {
  apiType: ApiType;
  kindCode: string;
  sidoCode: string;
  sggCode: string;
  year: number;
}): Promise<{
  httpOk: boolean;
  resultCode: string | null;
  list: Record<string, unknown>[];
}> {
  const res = await fetchApi({
    apiType: p.apiType,
    sidoCode: p.sidoCode,
    sggCode: p.sggCode,
    schulKndCode: p.kindCode,
    pbanYr: p.year,
  });
  return {
    httpOk: res.httpOk,
    resultCode: res.body ? String(res.body.resultCode ?? "") : null,
    list: res.httpOk && isSuccess(res.body) ? listOf(res.body) : [],
  };
}

/** Pick by SchoolInfo SCHUL_CODE only — no name-only fallback. */
async function fetchSectionBySchoolInfoCode(p: {
  apiType: ApiType;
  schoolInfoCode: string;
  kindCode: string;
  sidoCode: string;
  sggCode: string;
  yearList: number[];
}): Promise<Sec> {
  if (!hasApiKey()) {
    return {
      apiType: p.apiType,
      year: null,
      status: "auth_hold",
      row: null,
      resultCode: "auth_hold",
      httpOk: null,
      called: false,
    };
  }

  let lastCode: string | null = null;
  let lastHttp: boolean | null = null;
  let called = false;

  for (const year of p.yearList) {
    try {
      const res = await fetchList({
        apiType: p.apiType,
        kindCode: p.kindCode,
        sidoCode: p.sidoCode,
        sggCode: p.sggCode,
        year,
      });
      called = true;
      lastHttp = res.httpOk;
      lastCode = res.resultCode;
      if (!res.httpOk || res.list.length === 0) continue;

      const row = pickByCode(res.list, p.schoolInfoCode);
      if (!row) continue;

      return {
        apiType: p.apiType,
        year,
        status: "ok",
        row,
        resultCode: lastCode,
        httpOk: lastHttp,
        called: true,
      };
    } catch {
      called = true;
      lastHttp = false;
    }
  }

  return {
    apiType: p.apiType,
    year: null,
    status: called ? (lastHttp === false ? "error" : "missing") : "missing",
    row: null,
    resultCode: lastCode,
    httpOk: lastHttp,
    called,
  };
}

function authHold(schoolCode: string, nameHint: string | null): SchoolDetail {
  return {
    schoolCode,
    neisCode: schoolCode,
    schoolInfoCode: null,
    sameCode: false,
    mapping: "unresolved",
    name: nameHint?.trim() || schoolCode,
    kind: null,
    foundation: null,
    coedu: null,
    address: null,
    tel: null,
    homepage: null,
    office: null,
    foundedOn: null,
    core: {
      students: null,
      classes: null,
      classSize: null,
      teachers: null,
      studentsPerTeacher: null,
    },
    schoolLife: { mealPerStudent: null, afterSchoolPrograms: null },
    scholarship: null,
    referenceYears: [],
    sectionStatus: {
      basic: "auth_hold",
      students: "auth_hold",
      teachers: "auth_hold",
      meal: "auth_hold",
      afterSchool: "auth_hold",
      scholarship: "auth_hold",
    },
    auth: {
      keyPresent: false,
      called: false,
      httpOk: null,
      resultCode: "auth_hold",
    },
    attribution: "학교알리미 공시 기준",
  };
}

function unresolvedDetail(
  schoolCode: string,
  nameHint: string | null,
  auth: SchoolDetail["auth"],
): SchoolDetail {
  return {
    ...authHold(schoolCode, nameHint),
    mapping: "unresolved",
    auth,
    sectionStatus: {
      basic: "missing",
      students: "missing",
      teachers: "missing",
      meal: "missing",
      afterSchool: "missing",
      scholarship: "missing",
    },
  };
}

function rawNum(m: Metric | null): number | null {
  return m ? asNumber(m.raw) : null;
}

async function loadSchoolDetailBySchoolInfoCode(p: {
  appSchoolId: string;
  schoolInfoCode: string;
  resolveMethod: ResolveMethod;
  nameHint: string | null;
  kind: Kind;
  kindCode: string;
  sidoCode: string;
  sggCode: string;
  yearList: number[];
}): Promise<SchoolDetail> {
  const common = {
    schoolInfoCode: p.schoolInfoCode,
    kindCode: p.kindCode,
    sidoCode: p.sidoCode,
    sggCode: p.sggCode,
    yearList: p.yearList,
  };

  const [basicSec, studentsSec, teachersSec, mealSec, afterSec, scholarshipSec] =
    await Promise.all([
      fetchSectionBySchoolInfoCode({ ...common, apiType: "0" }),
      fetchSectionBySchoolInfoCode({ ...common, apiType: "09" }),
      fetchSectionBySchoolInfoCode({ ...common, apiType: "22" }),
      fetchSectionBySchoolInfoCode({ ...common, apiType: "35" }),
      fetchSectionBySchoolInfoCode({ ...common, apiType: "59" }),
      fetchSectionBySchoolInfoCode({ ...common, apiType: "55" }),
    ]);

  // apiType 09 → students/classes only (학년별·학급별 학생수). Not 진학/특목.
  const basic = parseBasic(basicSec.row);
  const st = parseStudentsTeachers(studentsSec.row);
  const teacherFb = parseTeacherHeadcount(teachersSec.row);
  const meal = parseMeal(mealSec.row);
  const after = parseAfterSchool(afterSec.row);
  const studentCount = rawNum(st.students);
  const scholarship = parseScholarship(scholarshipSec.row, studentCount);

  const schoolInfoCode = basic.schoolInfoCode ?? p.schoolInfoCode;
  const sameCode = schoolInfoCode === p.appSchoolId;
  const mapping = mappingFromMethod(p.resolveMethod);

  const teachers = st.teachers ?? teacherFb.teachers ?? null;
  let studentsPerTeacher = st.studentsPerTeacher;
  const teacherCount = rawNum(teachers);
  if (
    !studentsPerTeacher &&
    studentCount != null &&
    teacherCount != null &&
    teacherCount > 0
  ) {
    const d = studentCount / teacherCount;
    studentsPerTeacher = {
      label: "교원 1인당 학생수",
      value: `${Number.isInteger(d) ? d : d.toFixed(1)}명`,
      raw: d,
      derived: true,
      sourceField: "students/teachers",
    };
  }

  const yearsUsed = [
    basic.year,
    st.year,
    teacherFb.year,
    meal.year ?? (mealSec.year != null ? String(mealSec.year) : null),
    after.year,
    scholarship.year,
    basicSec.year != null ? String(basicSec.year) : null,
    studentsSec.year != null ? String(studentsSec.year) : null,
  ].filter((y): y is string => !!y);

  const anyCalled =
    basicSec.called ||
    studentsSec.called ||
    teachersSec.called ||
    mealSec.called ||
    afterSec.called ||
    scholarshipSec.called;

  const scholarshipBlock =
    scholarship.status === "ok"
      ? { total: scholarship.total, perStudent: scholarship.perStudent }
      : null;

  return {
    schoolCode: p.appSchoolId,
    neisCode: p.appSchoolId,
    schoolInfoCode,
    sameCode,
    mapping,
    name: basic.name || p.nameHint || p.appSchoolId,
    kind: basic.kind,
    foundation: basic.foundation,
    coedu: basic.coedu,
    address: basic.address,
    tel: basic.tel,
    homepage: basic.homepage,
    office: basic.office,
    foundedOn: basic.foundedOn,
    core: {
      students: st.students,
      classes: st.classes,
      classSize: st.classSize,
      teachers,
      studentsPerTeacher,
    },
    schoolLife: {
      mealPerStudent: meal.meal,
      afterSchoolPrograms: after.programs,
    },
    scholarship: scholarshipBlock,
    referenceYears: [...new Set(yearsUsed)],
    sectionStatus: {
      basic: basicSec.status === "ok" && basic.name ? "ok" : basicSec.status,
      students: st.status === "ok" ? "ok" : studentsSec.status,
      teachers: teachers ? "ok" : teachersSec.status,
      meal: meal.status === "ok" ? "ok" : mealSec.status,
      afterSchool: after.status === "ok" ? "ok" : afterSec.status,
      scholarship: scholarshipBlock ? "ok" : scholarshipSec.status,
    },
    auth: {
      keyPresent: true,
      called: anyCalled,
      httpOk: basicSec.httpOk ?? studentsSec.httpOk ?? null,
      resultCode: basicSec.resultCode ?? studentsSec.resultCode ?? null,
    },
    attribution: attribution(yearsUsed),
  };
}

export async function getSchoolDetail(
  params: GetSchoolDetailParams,
): Promise<SchoolDetail> {
  const appSchoolId = params.schoolCode.trim();
  const nameHint = params.nameHint?.trim() || null;
  const addressHint = params.addressHint?.trim() || null;
  const known = findKnownLink(appSchoolId);
  const kind: Kind =
    params.kind ??
    known?.kind ??
    inferKindFromNameHint(nameHint) ??
    "middle";
  const kindCode = KIND[kind];
  const sidoCode = params.sidoCode ?? known?.sidoCode ?? SEOUL_SIDO;
  const sggCode = params.sggCode ?? known?.sggCode ?? SONGPA_SGG;
  const yearList = years();

  if (!hasApiKey()) return authHold(appSchoolId, nameHint);

  // Resolve once from basic list (apiType 0) — never name-only permanent identity.
  let resolveMethod: ResolveMethod = "unresolved";
  let schoolInfoCode: string | null = null;
  let resolveHttpOk: boolean | null = null;
  let resolveResultCode: string | null = null;
  let resolveCalled = false;

  for (const year of yearList) {
    try {
      const basicList = await fetchList({
        apiType: "0",
        kindCode,
        sidoCode,
        sggCode,
        year,
      });
      resolveCalled = true;
      resolveHttpOk = basicList.httpOk;
      resolveResultCode = basicList.resultCode;
      if (!basicList.httpOk || basicList.list.length === 0) continue;

      const resolved = resolveSchoolInfoCode({
        appSchoolId,
        rows: basicList.list,
        nameHint,
        addressHint,
        kind,
      });
      if (resolved.schoolInfoCode) {
        schoolInfoCode = resolved.schoolInfoCode;
        resolveMethod = resolved.method;
        break;
      }
    } catch {
      resolveCalled = true;
      resolveHttpOk = false;
    }
  }

  if (!schoolInfoCode) {
    return unresolvedDetail(appSchoolId, nameHint, {
      keyPresent: true,
      called: resolveCalled,
      httpOk: resolveHttpOk,
      resultCode: resolveResultCode,
    });
  }

  // Cache by SchoolInfo SCHUL_CODE (official), not by display name.
  const cacheKey = schoolInfoDetailCacheKey(
    schoolInfoCode,
    appSchoolId,
    kind,
    sidoCode,
    sggCode,
  );
  const hit = detailCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }

  const value = await loadSchoolDetailBySchoolInfoCode({
    appSchoolId,
    schoolInfoCode,
    resolveMethod,
    nameHint,
    kind,
    kindCode,
    sidoCode,
    sggCode,
    yearList,
  });
  detailCache.set(cacheKey, {
    expiresAt: Date.now() + REVALIDATE_SECONDS * 1000,
    value,
  });
  return value;
}
