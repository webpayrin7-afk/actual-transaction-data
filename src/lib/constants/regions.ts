/** 안양시 전체 — 시군구(구) 법정동코드 앞 5자리 */
export const ANYANG_DISTRICTS = [
  { code: "41171", name: "만안구" },
  { code: "41173", name: "동안구" },
] as const;

export type DistrictCode = (typeof ANYANG_DISTRICTS)[number]["code"];
export type DistrictName = (typeof ANYANG_DISTRICTS)[number]["name"];

/** @deprecated 단일 구 코드 — 호환용. 실제 조회는 LAWD_CDS 사용 */
export const LAWD_CD = "41173";

export const LAWD_CDS: DistrictCode[] = ANYANG_DISTRICTS.map((d) => d.code);

export const REGION_LABEL = "안양시";
export const REGION_DETAIL = "만안구 · 동안구";

export const DISTRICT_OPTIONS = [
  { value: "all", label: "전체 구" },
  { value: "만안구", label: "만안구" },
  { value: "동안구", label: "동안구" },
] as const;

/** 안양시 법정동 (API umdNm 기준 + 동안구 세부 법정동) */
export const DONG_OPTIONS = [
  { value: "all", label: "전체 동", gu: "all" as const },
  // 만안구
  { value: "안양동", label: "안양동 (만안)", gu: "만안구" as const },
  { value: "석수동", label: "석수동 (만안)", gu: "만안구" as const },
  { value: "박달동", label: "박달동 (만안)", gu: "만안구" as const },
  // 동안구
  { value: "비산동", label: "비산동 (동안)", gu: "동안구" as const },
  { value: "관양동", label: "관양동 (동안)", gu: "동안구" as const },
  { value: "평촌동", label: "평촌동 (동안)", gu: "동안구" as const },
  { value: "호계동", label: "호계동 (동안)", gu: "동안구" as const },
  { value: "갈산동", label: "갈산동 (동안)", gu: "동안구" as const },
  { value: "달안동", label: "달안동 (동안)", gu: "동안구" as const },
  { value: "부림동", label: "부림동 (동안)", gu: "동안구" as const },
  { value: "귀인동", label: "귀인동 (동안)", gu: "동안구" as const },
  { value: "신촌동", label: "신촌동 (동안)", gu: "동안구" as const },
] as const;

export const DEAL_TYPE_OPTIONS = [
  { value: "all", label: "전체" },
  { value: "trade", label: "매매" },
  { value: "rent", label: "전월세" },
] as const;

export const AREA_OPTIONS = [
  { value: "all", label: "전체 면적" },
  { value: "under-60", label: "~60㎡ (약 18평)" },
  { value: "60-85", label: "60~85㎡ (약 18~25평)" },
  { value: "85-102", label: "85~102㎡ (약 25~30평)" },
  { value: "over-102", label: "102㎡~ (약 30평+)" },
] as const;

export const PAGE_SIZE = 15;

export const TRADE_API_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";

export const RENT_API_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent";

export function districtNameFromCode(code: string): DistrictName | "" {
  const found = ANYANG_DISTRICTS.find((d) => d.code === code);
  return found?.name ?? "";
}

export function dongOptionsForDistrict(gu: string) {
  if (gu === "all") return DONG_OPTIONS;
  return DONG_OPTIONS.filter((d) => d.value === "all" || d.gu === gu);
}
