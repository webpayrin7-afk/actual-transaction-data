/** 안양시 동안구 법정동코드 (앞 5자리) */
export const LAWD_CD = "41173";

export const REGION_LABEL = "안양시 동안구";

/** 안양시 동안구 주요 법정동 */
export const DONG_OPTIONS = [
  { value: "all", label: "전체 동" },
  { value: "평촌동", label: "평촌동" },
  { value: "관양동", label: "관양동" },
  { value: "비산동", label: "비산동" },
  { value: "호계동", label: "호계동" },
  { value: "갈산동", label: "갈산동" },
  { value: "달안동", label: "달안동" },
  { value: "부림동", label: "부림동" },
  { value: "귀인동", label: "귀인동" },
  { value: "신촌동", label: "신촌동" },
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
