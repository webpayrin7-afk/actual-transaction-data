/**
 * 전국 LAWD(시군구 5자리) 카탈로그.
 * Source: 행정표준코드 법정동코드 앞 5자리 (시군구 leaf만 — 시도/시 상위코드 제외)
 * MOLIT RTMS AptTrade/AptRent LAWD_CD와 동일 체계.
 *
 * 주의:
 * - 행정구역 개편 후 신코드 기준 (DB transactions·apt_complex_master와 동일):
 *   강원 51xxx, 전북 52xxx, 광주·전남 통합 12xxx(전남광주통합특별시),
 *   인천 제물포구 28125·영종구 28155·서해구 28275·검단구 28290.
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
  "51": "gangwon", // 강원특별자치도 신코드
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

/**
 * 전남광주통합특별시(12xxx): 옛 광주광역시 5개 구는 122xx~123xx(동구 12210 … 광산구 12330),
 * 나머지 시·군은 옛 전라남도. 사용자에게는 광주/전남을 따로 보여 준다.
 */
function metroFromMergedGwangjuJeonnam(lawdCd: string): NationwideMetro {
  const n = Number(lawdCd.slice(0, 5));
  return n >= 12200 && n < 12500 ? "gwangju" : "jeonnam";
}

export function metroFromLawdNationwide(lawdCd: string): NationwideMetro {
  const prefix = lawdCd.slice(0, 2);
  if (prefix === "12") return metroFromMergedGwangjuJeonnam(lawdCd);
  return PREFIX_METRO[prefix] ?? "other";
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
