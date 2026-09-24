/**
 * Official assignment-source rights and product-readiness audit.
 * Research / design only. Production assignment writes stay 0.
 */

export type RightsVerdict = "YES" | "NO" | "UNKNOWN";

export type DatasetRights = {
  datasetId: string;
  exactName: string;
  publisher: string;
  sourceVersion: string;
  updateCadence: string;
  formats: string;
  commercialUse: RightsVerdict;
  modification: RightsVerdict;
  redistribution: RightsVerdict;
  attribution: string;
  unresolved: string;
};

export const ASSIGNMENT_DATASET_RIGHTS: readonly DatasetRights[] = [
  {
    datasetId: "schoolzone.emac.kr + 15021149",
    exactName: "전국초등학교통학구역표준데이터 / 초등학교 통학구역 및 공동통학구역 SHP",
    publisher: "한국교육시설안전원 (소관: 교육부)",
    sourceVersion: "2026-03-20",
    updateCadence: "March and September (portal also marks 수시 for the standard dataset page)",
    formats: "SHP (EPSG:5186 Korea 2000 Central Belt 2010) + CSV attributes on data.go.kr",
    commercialUse: "UNKNOWN",
    modification: "UNKNOWN",
    redistribution: "UNKNOWN",
    attribution: "Publisher is identifiable, but no KOGL / 공공누리 type mark was found on the dataset page or in the 2026-03-20 standard PDF text extract.",
    unresolved: "RIGHTS_UNKNOWN. Do not assume SchoolInfo 공공저작물 제3유형 applies to KOIES polygons.",
  },
  {
    datasetId: "schoolzone.emac.kr + 15021151",
    exactName: "전국중학교학교군표준데이터 / 중학교 학구 및 학군 SHP",
    publisher: "한국교육시설안전원",
    sourceVersion: "2026-03-20",
    updateCadence: "March and September",
    formats: "SHP + CSV",
    commercialUse: "UNKNOWN",
    modification: "UNKNOWN",
    redistribution: "UNKNOWN",
    attribution: "No KOGL type found.",
    unresolved: "RIGHTS_UNKNOWN",
  },
  {
    datasetId: "schoolzone.emac.kr + 15021153",
    exactName: "전국고등학교학교군표준데이터 / 고등학교 학교군 SHP (+ 비평준화지역 SHP)",
    publisher: "한국교육시설안전원",
    sourceVersion: "2026-03-20",
    updateCadence: "March and September",
    formats: "SHP + CSV",
    commercialUse: "UNKNOWN",
    modification: "UNKNOWN",
    redistribution: "UNKNOWN",
    attribution: "No KOGL type found.",
    unresolved: "RIGHTS_UNKNOWN",
  },
  {
    datasetId: "15021148 + 15021158",
    exactName: "전국초중등학교위치표준데이터 + 전국학교학구도연계정보표준데이터",
    publisher: "한국교육시설안전원",
    sourceVersion: "2026-03-20",
    updateCadence: "March and September",
    formats: "CSV (학교ID B…; linkage 학구ID↔학교ID)",
    commercialUse: "UNKNOWN",
    modification: "UNKNOWN",
    redistribution: "UNKNOWN",
    attribution: "No KOGL type found.",
    unresolved: "RIGHTS_UNKNOWN. Required for school-area membership joins.",
  },
];

export const ASSIGNMENT_PRODUCTION_WRITES = 0;

export const PRODUCT_DECISION = {
  ELEMENTARY_ASSIGNMENT: "HOLD",
  MIDDLE_GROUP: "HOLD",
  HIGH_GROUP: "HOLD",
  EXACT_MIDDLE_ASSIGNMENT: "HOLD",
  EXACT_HIGH_ASSIGNMENT: "HOLD",
  reason:
    "Rights are RIGHTS_UNKNOWN. Technical crosswalk and elementary point-in-polygon pilot succeed, but commercial display/redistribution is not verified. Exact middle/high student assignment is not supported by group polygons.",
} as const;

export const CLAIM_RULES = {
  elementary_allowed_if_rights_cleared:
    "공식 통학구역 소속 초등학교 (학구ID + linked school). Not nearest school.",
  middle_allowed_if_rights_cleared:
    "중학교 학교군 / 중학구 소속 학교 목록. AREA/GROUP MEMBERSHIP only.",
  middle_forbidden: "배정 중학교 / this student is assigned to school X",
  high_allowed_if_rights_cleared:
    "고등학교 학교군 / 평준화·비평준화 지역 membership. 교육감 배정 학교군 label only as group membership.",
  high_forbidden: "이 아파트 배정 고등학교",
} as const;
