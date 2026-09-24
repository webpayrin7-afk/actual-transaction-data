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
 * Result: VERIFIED — KOIES 학구도 SHP (BASE_DT 2026-03-20) PIP at product map anchor.
 */
export function auditJamsilElsElementaryCatchment(): CatchmentAudit {
  return {
    decision: "VERIFIED",
    candidateSchoolName: "서울잠일초등학교",
    officialSource: "한국교육시설안전원 학구도안내서비스 · 초등학교통학구역 SHP",
    parcelLinkEvidence:
      "product map anchor(올림픽로 99 / 잠실동 19) ∈ 서울잠일초통학구역(Z000100307, HAKGUDO_GB=0)",
    evidence:
      "공식 통학구역 SHP에서 단지 좌표 PIP 1건(서울잠일초통학구역). 공동통학구역 아님. NEIS 7130153.",
    neededSources: [],
  };
}

export function isJamsilElsSchoolPilot(aptName: string): boolean {
  const norm = aptName.replace(/\s+/g, "");
  return (JAMSIL_ELS_PILOT_APT_NAMES as readonly string[]).some(
    (n) => n.replace(/\s+/g, "") === norm || norm.startsWith(n),
  );
}
