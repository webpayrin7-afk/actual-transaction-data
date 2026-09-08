export {
  AREA_OPTIONS,
  DEAL_TYPE_OPTIONS,
  FEATURED_LAWD_CODES,
  PAGE_SIZE,
  RENT_API_URL,
  TRADE_API_URL,
  ALL_REGIONS,
  CAPITAL_REGIONS,
  SEOUL_REGIONS,
  GYEONGGI_REGIONS,
  NATIONWIDE_REGIONS,
  NATIONWIDE_EXTRA_REGIONS,
  REGION_BY_SLUG,
  LAWD_TO_REGION,
  getRegion,
  districtNameFromCode,
  allNationwideLawdCodes,
  allCapitalLawdCodes,
  type Metro,
  type RegionDef,
  type DistrictUnit,
} from "./regions-registry";

export {
  METRO_LABELS,
  metroFromLawdNationwide,
  NATIONWIDE_LAWD_CODES,
  type NationwideMetro,
} from "./nationwide-lawd";

/** @deprecated 호환용 — 단일 지역 기본값 */
export const LAWD_CD = "41173";
export const LAWD_CDS = ["41171", "41173"];
export const REGION_LABEL = "아파트 데이터랩";
/** 실제 적재 coverage 문구 — 전국 historical 적재 완료 전 유지 */
export const REGION_DETAIL = "서울 · 경기";

export const DISTRICT_OPTIONS = [
  { value: "all", label: "전체 구" },
] as const;
