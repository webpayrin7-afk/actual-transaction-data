/**
 * ZIPLAB School Data Pilot Phase 8.1 — 잠실엘스 only.
 *
 * Catchment (통학구역) is intentionally HOLD until an official Seoul
 * education-office catchment source can be linked to the complex parcel.
 * Competitor UIs are not evidence.
 */

export const JAMSIL_ELS_PILOT_APT_NAMES = ["잠실엘스", "잠실엘스아파트"] as const;

/** Seoul Metropolitan Office of Education (NEIS). */
export const SEOUL_OFCDC_CODE = "B10";

/**
 * Address dongs used to scope "nearby" schools for 잠실엘스 without inventing
 * catchment. Not a substitute for official 통학구역 polygons.
 */
export const JAMSIL_ELS_NEARBY_DONGS = ["잠실동", "신천동"] as const;

export const JAMSIL_ELS_NEARBY_GU = "송파구";

/**
 * NEIS SCHUL_NM search seeds (partial match). Scoped fetch only — not nationwide bulk.
 */
export const JAMSIL_ELS_NEIS_NAME_SEEDS = [
  "잠일",
  "잠실",
  "잠신",
  "잠동",
  "신천",
  "정신",
  "영동일",
  "잠일고",
] as const;

export type CatchmentDecision = "VERIFIED" | "HOLD";

export type CatchmentAudit = {
  decision: CatchmentDecision;
  candidateSchoolName: string;
  officialSource: string | null;
  parcelLinkEvidence: string | null;
  evidence: string;
  neededSources: string[];
};

/**
 * Audit: can we prove 서울잠일초등학교 is the official catchment school for 잠실엘스?
 * Result: HOLD — no approved official catchment dataset in code/data today.
 */
export function auditJamsilElsElementaryCatchment(): CatchmentAudit {
  return {
    decision: "HOLD",
    candidateSchoolName: "서울잠일초등학교",
    officialSource: null,
    parcelLinkEvidence: null,
    evidence:
      "저장소·승인 데이터에 서울시교육청 통학구역(학구도) GIS/표와 단지 필지(송파구 잠실동 19)를 연결한 근거가 없다. NEIS 학교목록·경쟁사 표시는 통학구역 증거가 아니다.",
    neededSources: [
      "서울특별시교육청(또는 송파교육지원청) 공식 초등학교 통학구역 데이터",
      "단지 주소/필지(잠실동 19) ↔ 학구 폴리곤·배정학교 매칭 근거",
      "자료 기준일·고시 버전",
    ],
  };
}

export function isJamsilElsSchoolPilot(aptName: string): boolean {
  const norm = aptName.replace(/\s+/g, "");
  return (JAMSIL_ELS_PILOT_APT_NAMES as readonly string[]).some(
    (n) => n.replace(/\s+/g, "") === norm || norm.startsWith(n),
  );
}
