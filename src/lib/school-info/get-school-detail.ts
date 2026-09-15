/**
 * School detail loader — /school/[schoolCode] only.
 * Do not call from apt detail or nearby school list.
 */

import {
  fetchApi,
  hasApiKey,
  isSuccess,
  listOf,
  type ApiType,
} from "@/lib/school-info/client";
import {
  codeOf,
  KIND,
  pickByCode,
  pickByName,
  SEOUL_SIDO,
  SONGPA_SGG,
  years,
  type Kind,
} from "@/lib/school-info/identity";
import {
  asNumber,
  attribution,
  parseAfterSchool,
  parseAdvancement,
  parseBasic,
  parseMeal,
  parseScholarship,
  parseStudentsTeachers,
  parseTeacherHeadcount,
} from "@/lib/school-info/normalize";
import type { Metric, SchoolDetail, SectionStatus } from "@/lib/school-info/types";

export type GetSchoolDetailParams = {
  schoolCode: string;
  nameHint?: string | null;
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

async function fetchSection(p: {
  apiType: ApiType;
  schoolCode: string;
  nameHint: string | null;
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
      const res = await fetchApi({
        apiType: p.apiType,
        sidoCode: p.sidoCode,
        sggCode: p.sggCode,
        schulKndCode: p.kindCode,
        pbanYr: year,
      });
      called = true;
      lastHttp = res.httpOk;
      lastCode = res.body ? String(res.body.resultCode ?? "") : null;
      if (!res.httpOk || !isSuccess(res.body)) continue;

      const list = listOf(res.body);
      const row =
        pickByCode(list, p.schoolCode) ??
        (p.nameHint ? pickByName(list, p.nameHint) : null);
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
    advancement: null,
    scholarship: null,
    referenceYears: [],
    sectionStatus: {
      basic: "auth_hold",
      students: "auth_hold",
      teachers: "auth_hold",
      meal: "auth_hold",
      afterSchool: "auth_hold",
      advancement: "auth_hold",
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

function rawNum(m: Metric | null): number | null {
  return m ? asNumber(m.raw) : null;
}

export async function getSchoolDetail(
  params: GetSchoolDetailParams,
): Promise<SchoolDetail> {
  const schoolCode = params.schoolCode.trim();
  const nameHint = params.nameHint?.trim() || null;
  const kind = params.kind ?? "middle";
  const kindCode = KIND[kind];
  const sidoCode = params.sidoCode ?? SEOUL_SIDO;
  const sggCode = params.sggCode ?? SONGPA_SGG;
  const yearList = years();

  if (!hasApiKey()) return authHold(schoolCode, nameHint);

  const common = {
    schoolCode,
    nameHint,
    kindCode,
    sidoCode,
    sggCode,
    yearList,
  };

  const [basicSec, studentsSec, teachersSec, mealSec, afterSec, scholarshipSec] =
    await Promise.all([
      fetchSection({ ...common, apiType: "0" }),
      fetchSection({ ...common, apiType: "09" }),
      fetchSection({ ...common, apiType: "22" }),
      fetchSection({ ...common, apiType: "35" }),
      fetchSection({ ...common, apiType: "59" }),
      fetchSection({ ...common, apiType: "55" }),
    ]);

  const advStudents = parseAdvancement(studentsSec.row);
  const advBasic = parseAdvancement(basicSec.row);
  const adv = advStudents.status === "ok" ? advStudents : advBasic;

  const basic = parseBasic(basicSec.row);
  const st = parseStudentsTeachers(studentsSec.row);
  const teacherFb = parseTeacherHeadcount(teachersSec.row);
  const meal = parseMeal(mealSec.row);
  const after = parseAfterSchool(afterSec.row);
  const studentCount = rawNum(st.students);
  const scholarship = parseScholarship(scholarshipSec.row, studentCount);

  const schoolInfoCode =
    basic.schoolInfoCode ?? codeOf(basicSec.row) ?? codeOf(studentsSec.row);
  const sameCode = !!(schoolInfoCode && schoolInfoCode === schoolCode);
  const mapping: SchoolDetail["mapping"] = !schoolInfoCode
    ? "unresolved"
    : sameCode
      ? "same_code"
      : "runtime_name_region";

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
    meal.year,
    after.year,
    scholarship.year,
    adv.year,
  ].filter((y): y is string => !!y);

  const anyCalled =
    basicSec.called ||
    studentsSec.called ||
    teachersSec.called ||
    mealSec.called ||
    afterSec.called ||
    scholarshipSec.called;

  const advancement =
    adv.status === "ok"
      ? { graduates: adv.graduates, buckets: adv.buckets }
      : null;
  const scholarshipBlock =
    scholarship.status === "ok"
      ? { total: scholarship.total, perStudent: scholarship.perStudent }
      : null;

  return {
    schoolCode,
    neisCode: schoolCode,
    schoolInfoCode,
    sameCode,
    mapping,
    name: basic.name || nameHint || schoolCode,
    kind: basic.kind,
    foundation: basic.foundation,
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
    advancement,
    scholarship: scholarshipBlock,
    referenceYears: [...new Set(yearsUsed)],
    sectionStatus: {
      basic: basicSec.status === "ok" && basic.name ? "ok" : basicSec.status,
      students: st.status === "ok" ? "ok" : studentsSec.status,
      teachers: teachers ? "ok" : teachersSec.status,
      meal: meal.status === "ok" ? "ok" : mealSec.status,
      afterSchool: after.status === "ok" ? "ok" : afterSec.status,
      advancement: advancement ? "ok" : "missing",
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
