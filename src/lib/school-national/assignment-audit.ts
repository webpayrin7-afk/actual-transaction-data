/**
 * Official assignment-source audit. Research only.
 * These records are not loaded into production.
 */

export type AssignmentSourceAudit = {
  level: "elementary" | "middle" | "high";
  question: string;
  officialSource: string;
  geographyType: string;
  yearVersion: string;
  schoolLinkageKey: string;
  updateCadence: string;
  redistribution: string;
  scalableNationwide: "NO";
  recommendation: "HOLD";
  claimExactAssignedSchool: false;
};

export const ASSIGNMENT_SOURCE_AUDIT: readonly AssignmentSourceAudit[] = [
  {
    level: "elementary",
    question: "elementary school attendance districts (통학구역)",
    officialSource:
      "한국교육시설안전원 학구도안내서비스 https://schoolzone.emac.kr/publicData/dataInfo.do and 공공데이터포털 전국초등학교통학구역표준데이터 https://www.data.go.kr/data/15021149/standard.do (초·중등교육법 시행령 제16조)",
    geographyType: "SHP attendance-zone polygon plus CSV attributes (학구ID, 학구명, 학구분류). Sample 학구ID Z000101365.",
    yearVersion: "Data basis 2026-03-20, portal file registered 2026-04-21. Prior drop 2025-09-22.",
    schoolLinkageKey:
      "Separate 전국학교학구도연계정보 https://www.data.go.kr/data/15021158/standard.do uses KOIES 학교ID (sample B000002433), not SchoolInfo SCHUL_CODE.",
    updateCadence: "KOIES publishes the seven school-zone datasets in March and September.",
    redistribution:
      "Publisher is 한국교육시설안전원 via data.go.kr. The extracted portal page does not state a commercial-use grant. SchoolInfo OpenAPI remains 공공저작물 제3유형 (출처표시·변경금지) and is a different dataset.",
    scalableNationwide: "NO",
    recommendation: "HOLD",
    claimExactAssignedSchool: false,
  },
  {
    level: "middle",
    question: "middle-school assignment zones/groups (학교군, 중학구, 추첨/배정)",
    officialSource:
      "한국교육시설안전원 중학교 학구 및 학군 SHP (2026-03-20 list on schoolzone.emac.kr) and 공공데이터포털 전국중학교학교군표준데이터 https://www.data.go.kr/data/15021151/standard.do (시행령 제68조)",
    geographyType: "SHP school-group / middle-school district polygon. Not a student-level lottery result.",
    yearVersion: "2026-03-20 file set, registered on the KOIES list 2026-05-19.",
    schoolLinkageKey: "KOIES 학교ID on the separate linkage CSV, not SchoolInfo SCHUL_CODE.",
    updateCadence: "March and September.",
    redistribution: "Same KOIES / data.go.kr publication. Commercial terms not verified on the portal extract.",
    scalableNationwide: "NO",
    recommendation: "HOLD",
    claimExactAssignedSchool: false,
  },
  {
    level: "high",
    question: "high-school districts/groups and superintendent allocation category",
    officialSource:
      "한국교육시설안전원 고등학교 학교군 SHP and 고등학교 비평준화지역 SHP (2026-03-20). 공공데이터포털 전국고등학교학교군표준데이터 https://www.data.go.kr/data/15021153/standard.do. 강동송파 group pilot stays reference only.",
    geographyType: "SHP school-group polygon for standardized areas, plus a separate non-standardized area layer. Not an allocation of one student to one school.",
    yearVersion: "2026-03-20.",
    schoolLinkageKey: "KOIES 학교ID, not SchoolInfo SCHUL_CODE.",
    updateCadence: "March and September.",
    redistribution: "Same KOIES / data.go.kr publication. Commercial terms not verified on the portal extract.",
    scalableNationwide: "NO",
    recommendation: "HOLD",
    claimExactAssignedSchool: false,
  },
];

export const ASSIGNMENT_PRODUCTION_WRITES = 0;
