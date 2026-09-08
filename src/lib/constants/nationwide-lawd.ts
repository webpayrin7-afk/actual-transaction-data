/**
 * 전국 LAWD(시군구 5자리) 카탈로그.
 * Source: 행정표준코드 법정동코드 앞 5자리 (시군구 leaf만 — 시도/시 상위코드 제외)
 * MOLIT RTMS AptTrade/AptRent LAWD_CD와 동일 체계.
 *
 * 주의:
 * - 강원/전북 등은 특별자치 개편 후에도 MOLIT가 구 코드(42xx/45xx)를 쓰는 경우가 많아
 *   구 코드 기준으로 유지. 운영 중 API NODATA면 대체 코드 검증 필요.
 * - 군위군(舊 47720) 등 이전 지역은 검증 전까지 제외.
 */
import nationwideLawdJson from "./nationwide-lawd.json";

export type NationwideLawdRow = {
  code: string;
  fullName: string;
};

export const NATIONWIDE_LAWD_ROWS: NationwideLawdRow[] =
  nationwideLawdJson as NationwideLawdRow[];

export const NATIONWIDE_LAWD_CODES: string[] = NATIONWIDE_LAWD_ROWS.map(
  (r) => r.code,
);

/** 시도 접두 → 메트로 키 (UI/stats scope 확장용) */
export type NationwideMetro =
  | "seoul"
  | "busan"
  | "daegu"
  | "incheon"
  | "gwangju"
  | "daejeon"
  | "ulsan"
  | "sejong"
  | "gyeonggi"
  | "gangwon"
  | "chungbuk"
  | "chungnam"
  | "jeonbuk"
  | "jeonnam"
  | "gyeongbuk"
  | "gyeongnam"
  | "jeju"
  | "other";

const PREFIX_METRO: Record<string, NationwideMetro> = {
  "11": "seoul",
  "26": "busan",
  "27": "daegu",
  "28": "incheon",
  "29": "gwangju",
  "30": "daejeon",
  "31": "ulsan",
  "36": "sejong",
  "41": "gyeonggi",
  "42": "gangwon",
  "51": "gangwon", // 강원특별자치도 신코드 (검증용)
  "43": "chungbuk",
  "44": "chungnam",
  "45": "jeonbuk",
  "52": "jeonbuk",
  "46": "jeonnam",
  "47": "gyeongbuk",
  "48": "gyeongnam",
  "50": "jeju",
};

export const METRO_LABELS: Record<NationwideMetro, string> = {
  seoul: "서울",
  busan: "부산",
  daegu: "대구",
  incheon: "인천",
  gwangju: "광주",
  daejeon: "대전",
  ulsan: "울산",
  sejong: "세종",
  gyeonggi: "경기",
  gangwon: "강원",
  chungbuk: "충북",
  chungnam: "충남",
  jeonbuk: "전북",
  jeonnam: "전남",
  gyeongbuk: "경북",
  gyeongnam: "경남",
  jeju: "제주",
  other: "기타",
};

export function metroFromLawdNationwide(lawdCd: string): NationwideMetro {
  return PREFIX_METRO[lawdCd.slice(0, 2)] ?? "other";
}

export function sidoFromFullName(fullName: string): string {
  const parts = fullName.split(/\s+/);
  return parts[0] ?? fullName;
}

/** slug: metro + LAWD_CD — 기존 서울·경기 ASCII slug와 충돌 없이 unique */
export function slugFromLawd(_fullName: string, code: string): string {
  const metro = metroFromLawdNationwide(code);
  return `${metro}-${code}`;
}
