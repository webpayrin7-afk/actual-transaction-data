import { NATIONWIDE_EXTRA_REGIONS } from "./nationwide-extra-regions";
import {
  NATIONWIDE_LAWD_CODES,
  type NationwideMetro,
} from "./nationwide-lawd";

export { NATIONWIDE_EXTRA_REGIONS };

/** 전국 시·도 키 (서울·경기 + 확대분) */
export type Metro = NationwideMetro;

export interface DistrictUnit {
  code: string;
  name: string;
}

export interface RegionDef {
  slug: string;
  metro: Metro;
  name: string; // 표시명 (강남구, 수원시)
  fullName: string;
  lawdCodes: string[];
  districts: DistrictUnit[];
}

export const SEOUL_REGIONS: RegionDef[] = [
  { slug: "seoul-jongno", metro: "seoul", name: "종로구", fullName: "서울특별시 종로구", lawdCodes: ["11110"], districts: [{ code: "11110", name: "종로구" }] },
  { slug: "seoul-jung", metro: "seoul", name: "중구", fullName: "서울특별시 중구", lawdCodes: ["11140"], districts: [{ code: "11140", name: "중구" }] },
  { slug: "seoul-yongsan", metro: "seoul", name: "용산구", fullName: "서울특별시 용산구", lawdCodes: ["11170"], districts: [{ code: "11170", name: "용산구" }] },
  { slug: "seoul-seongdong", metro: "seoul", name: "성동구", fullName: "서울특별시 성동구", lawdCodes: ["11200"], districts: [{ code: "11200", name: "성동구" }] },
  { slug: "seoul-gwangjin", metro: "seoul", name: "광진구", fullName: "서울특별시 광진구", lawdCodes: ["11215"], districts: [{ code: "11215", name: "광진구" }] },
  { slug: "seoul-dongdaemun", metro: "seoul", name: "동대문구", fullName: "서울특별시 동대문구", lawdCodes: ["11230"], districts: [{ code: "11230", name: "동대문구" }] },
  { slug: "seoul-jungnang", metro: "seoul", name: "중랑구", fullName: "서울특별시 중랑구", lawdCodes: ["11260"], districts: [{ code: "11260", name: "중랑구" }] },
  { slug: "seoul-seongbuk", metro: "seoul", name: "성북구", fullName: "서울특별시 성북구", lawdCodes: ["11290"], districts: [{ code: "11290", name: "성북구" }] },
  { slug: "seoul-gangbuk", metro: "seoul", name: "강북구", fullName: "서울특별시 강북구", lawdCodes: ["11305"], districts: [{ code: "11305", name: "강북구" }] },
  { slug: "seoul-dobong", metro: "seoul", name: "도봉구", fullName: "서울특별시 도봉구", lawdCodes: ["11320"], districts: [{ code: "11320", name: "도봉구" }] },
  { slug: "seoul-nowon", metro: "seoul", name: "노원구", fullName: "서울특별시 노원구", lawdCodes: ["11350"], districts: [{ code: "11350", name: "노원구" }] },
  { slug: "seoul-eunpyeong", metro: "seoul", name: "은평구", fullName: "서울특별시 은평구", lawdCodes: ["11380"], districts: [{ code: "11380", name: "은평구" }] },
  { slug: "seoul-seodaemun", metro: "seoul", name: "서대문구", fullName: "서울특별시 서대문구", lawdCodes: ["11410"], districts: [{ code: "11410", name: "서대문구" }] },
  { slug: "seoul-mapo", metro: "seoul", name: "마포구", fullName: "서울특별시 마포구", lawdCodes: ["11440"], districts: [{ code: "11440", name: "마포구" }] },
  { slug: "seoul-yangcheon", metro: "seoul", name: "양천구", fullName: "서울특별시 양천구", lawdCodes: ["11470"], districts: [{ code: "11470", name: "양천구" }] },
  { slug: "seoul-gangseo", metro: "seoul", name: "강서구", fullName: "서울특별시 강서구", lawdCodes: ["11500"], districts: [{ code: "11500", name: "강서구" }] },
  { slug: "seoul-guro", metro: "seoul", name: "구로구", fullName: "서울특별시 구로구", lawdCodes: ["11530"], districts: [{ code: "11530", name: "구로구" }] },
  { slug: "seoul-geumcheon", metro: "seoul", name: "금천구", fullName: "서울특별시 금천구", lawdCodes: ["11545"], districts: [{ code: "11545", name: "금천구" }] },
  { slug: "seoul-yeongdeungpo", metro: "seoul", name: "영등포구", fullName: "서울특별시 영등포구", lawdCodes: ["11560"], districts: [{ code: "11560", name: "영등포구" }] },
  { slug: "seoul-dongjak", metro: "seoul", name: "동작구", fullName: "서울특별시 동작구", lawdCodes: ["11590"], districts: [{ code: "11590", name: "동작구" }] },
  { slug: "seoul-gwanak", metro: "seoul", name: "관악구", fullName: "서울특별시 관악구", lawdCodes: ["11620"], districts: [{ code: "11620", name: "관악구" }] },
  { slug: "seoul-seocho", metro: "seoul", name: "서초구", fullName: "서울특별시 서초구", lawdCodes: ["11650"], districts: [{ code: "11650", name: "서초구" }] },
  { slug: "seoul-gangnam", metro: "seoul", name: "강남구", fullName: "서울특별시 강남구", lawdCodes: ["11680"], districts: [{ code: "11680", name: "강남구" }] },
  { slug: "seoul-songpa", metro: "seoul", name: "송파구", fullName: "서울특별시 송파구", lawdCodes: ["11710"], districts: [{ code: "11710", name: "송파구" }] },
  { slug: "seoul-gangdong", metro: "seoul", name: "강동구", fullName: "서울특별시 강동구", lawdCodes: ["11740"], districts: [{ code: "11740", name: "강동구" }] },
];

export const GYEONGGI_REGIONS: RegionDef[] = [
  { slug: "gyeonggi-suwon", metro: "gyeonggi", name: "수원시", fullName: "경기도 수원시", lawdCodes: ["41111", "41113", "41115", "41117"], districts: [{ code: "41111", name: "장안구" }, { code: "41113", name: "권선구" }, { code: "41115", name: "팔달구" }, { code: "41117", name: "영통구" }] },
  { slug: "gyeonggi-seongnam", metro: "gyeonggi", name: "성남시", fullName: "경기도 성남시", lawdCodes: ["41131", "41133", "41135"], districts: [{ code: "41131", name: "수정구" }, { code: "41133", name: "중원구" }, { code: "41135", name: "분당구" }] },
  { slug: "gyeonggi-uijeongbu", metro: "gyeonggi", name: "의정부시", fullName: "경기도 의정부시", lawdCodes: ["41150"], districts: [{ code: "41150", name: "의정부시" }] },
  { slug: "gyeonggi-anyang", metro: "gyeonggi", name: "안양시", fullName: "경기도 안양시", lawdCodes: ["41171", "41173"], districts: [{ code: "41171", name: "만안구" }, { code: "41173", name: "동안구" }] },
  { slug: "gyeonggi-bucheon", metro: "gyeonggi", name: "부천시", fullName: "경기도 부천시", lawdCodes: ["41190"], districts: [{ code: "41190", name: "부천시" }] },
  { slug: "gyeonggi-gwangmyeong", metro: "gyeonggi", name: "광명시", fullName: "경기도 광명시", lawdCodes: ["41210"], districts: [{ code: "41210", name: "광명시" }] },
  { slug: "gyeonggi-pyeongtaek", metro: "gyeonggi", name: "평택시", fullName: "경기도 평택시", lawdCodes: ["41220"], districts: [{ code: "41220", name: "평택시" }] },
  { slug: "gyeonggi-dongducheon", metro: "gyeonggi", name: "동두천시", fullName: "경기도 동두천시", lawdCodes: ["41250"], districts: [{ code: "41250", name: "동두천시" }] },
  { slug: "gyeonggi-ansan", metro: "gyeonggi", name: "안산시", fullName: "경기도 안산시", lawdCodes: ["41271", "41273"], districts: [{ code: "41271", name: "상록구" }, { code: "41273", name: "단원구" }] },
  { slug: "gyeonggi-goyang", metro: "gyeonggi", name: "고양시", fullName: "경기도 고양시", lawdCodes: ["41281", "41285", "41287"], districts: [{ code: "41281", name: "덕양구" }, { code: "41285", name: "일산동구" }, { code: "41287", name: "일산서구" }] },
  { slug: "gyeonggi-gwacheon", metro: "gyeonggi", name: "과천시", fullName: "경기도 과천시", lawdCodes: ["41290"], districts: [{ code: "41290", name: "과천시" }] },
  { slug: "gyeonggi-guri", metro: "gyeonggi", name: "구리시", fullName: "경기도 구리시", lawdCodes: ["41310"], districts: [{ code: "41310", name: "구리시" }] },
  { slug: "gyeonggi-namyangju", metro: "gyeonggi", name: "남양주시", fullName: "경기도 남양주시", lawdCodes: ["41360"], districts: [{ code: "41360", name: "남양주시" }] },
  { slug: "gyeonggi-osan", metro: "gyeonggi", name: "오산시", fullName: "경기도 오산시", lawdCodes: ["41370"], districts: [{ code: "41370", name: "오산시" }] },
  { slug: "gyeonggi-siheung", metro: "gyeonggi", name: "시흥시", fullName: "경기도 시흥시", lawdCodes: ["41390"], districts: [{ code: "41390", name: "시흥시" }] },
  { slug: "gyeonggi-gunpo", metro: "gyeonggi", name: "군포시", fullName: "경기도 군포시", lawdCodes: ["41410"], districts: [{ code: "41410", name: "군포시" }] },
  { slug: "gyeonggi-uiwang", metro: "gyeonggi", name: "의왕시", fullName: "경기도 의왕시", lawdCodes: ["41430"], districts: [{ code: "41430", name: "의왕시" }] },
  { slug: "gyeonggi-hanam", metro: "gyeonggi", name: "하남시", fullName: "경기도 하남시", lawdCodes: ["41450"], districts: [{ code: "41450", name: "하남시" }] },
  { slug: "gyeonggi-yongin", metro: "gyeonggi", name: "용인시", fullName: "경기도 용인시", lawdCodes: ["41461", "41463", "41465"], districts: [{ code: "41461", name: "처인구" }, { code: "41463", name: "기흥구" }, { code: "41465", name: "수지구" }] },
  { slug: "gyeonggi-paju", metro: "gyeonggi", name: "파주시", fullName: "경기도 파주시", lawdCodes: ["41480"], districts: [{ code: "41480", name: "파주시" }] },
  { slug: "gyeonggi-icheon", metro: "gyeonggi", name: "이천시", fullName: "경기도 이천시", lawdCodes: ["41500"], districts: [{ code: "41500", name: "이천시" }] },
  { slug: "gyeonggi-anseong", metro: "gyeonggi", name: "안성시", fullName: "경기도 안성시", lawdCodes: ["41550"], districts: [{ code: "41550", name: "안성시" }] },
  { slug: "gyeonggi-gimpo", metro: "gyeonggi", name: "김포시", fullName: "경기도 김포시", lawdCodes: ["41570"], districts: [{ code: "41570", name: "김포시" }] },
  { slug: "gyeonggi-hwaseong", metro: "gyeonggi", name: "화성시", fullName: "경기도 화성시", lawdCodes: ["41590"], districts: [{ code: "41590", name: "화성시" }] },
  { slug: "gyeonggi-gwangju", metro: "gyeonggi", name: "광주시", fullName: "경기도 광주시", lawdCodes: ["41610"], districts: [{ code: "41610", name: "광주시" }] },
  { slug: "gyeonggi-yangju", metro: "gyeonggi", name: "양주시", fullName: "경기도 양주시", lawdCodes: ["41630"], districts: [{ code: "41630", name: "양주시" }] },
  { slug: "gyeonggi-pocheon", metro: "gyeonggi", name: "포천시", fullName: "경기도 포천시", lawdCodes: ["41650"], districts: [{ code: "41650", name: "포천시" }] },
  { slug: "gyeonggi-yeoju", metro: "gyeonggi", name: "여주시", fullName: "경기도 여주시", lawdCodes: ["41670"], districts: [{ code: "41670", name: "여주시" }] },
  { slug: "gyeonggi-yeoncheon", metro: "gyeonggi", name: "연천군", fullName: "경기도 연천군", lawdCodes: ["41800"], districts: [{ code: "41800", name: "연천군" }] },
  { slug: "gyeonggi-gapyeong", metro: "gyeonggi", name: "가평군", fullName: "경기도 가평군", lawdCodes: ["41820"], districts: [{ code: "41820", name: "가평군" }] },
  { slug: "gyeonggi-yangpyeong", metro: "gyeonggi", name: "양평군", fullName: "경기도 양평군", lawdCodes: ["41830"], districts: [{ code: "41830", name: "양평군" }] },
];

/** 기존 UI/카탈로그 기본 세트 (서울·경기) — 하위 호환 */
export const CAPITAL_REGIONS: RegionDef[] = [
  ...SEOUL_REGIONS,
  ...GYEONGGI_REGIONS,
];

/**
 * 서비스에 등록된 전체 지역 (전국 leaf LAWD).
 * 데이터 coverage와 별개 — sync/검색/slug 해석용.
 * 실제 적재 범위는 sync_months / REGION_DETAIL 문구를 본다.
 */
export const ALL_REGIONS: RegionDef[] = [
  ...CAPITAL_REGIONS,
  ...NATIONWIDE_EXTRA_REGIONS,
];

/** @deprecated 이름 호환 — CAPITAL_REGIONS와 동일 취지였음. 이제는 전국 포함. */
export const NATIONWIDE_REGIONS: RegionDef[] = ALL_REGIONS;

export const REGION_BY_SLUG: Record<string, RegionDef> = Object.fromEntries(
  ALL_REGIONS.map((r) => [r.slug, r]),
);

export const LAWD_TO_REGION: Record<string, RegionDef> = {};
for (const region of ALL_REGIONS) {
  for (const code of region.lawdCodes) {
    LAWD_TO_REGION[code] = region;
  }
}

/** sync --scope=nationwide 용 unique LAWD */
export function allNationwideLawdCodes(): string[] {
  return [...new Set(NATIONWIDE_LAWD_CODES)];
}

export function allCapitalLawdCodes(): string[] {
  return [...new Set(CAPITAL_REGIONS.flatMap((r) => r.lawdCodes))];
}

export function getRegion(slug: string): RegionDef | undefined {
  return REGION_BY_SLUG[slug];
}

export function districtNameFromCode(code: string): string {
  for (const region of ALL_REGIONS) {
    const hit = region.districts.find((d) => d.code === code);
    if (hit) {
      if (region.metro === "seoul") return hit.name;
      return region.districts.length > 1 ? `${region.name} ${hit.name}` : region.name;
    }
  }
  return "";
}

/** 메인 TOP용 — API 호출량 제한을 위한 주요 지역 코드 */
export const FEATURED_LAWD_CODES = [
  "11680", // 강남
  "11710", // 송파
  "11650", // 서초
  "11440", // 마포
  "11500", // 강서
  "41135", // 분당
  "41117", // 영통
  "41171", // 만안 (안양역 일대)
  "41173", // 동안
  "41285", // 일산동
  "41463", // 기흥
  "41590", // 화성
  "41480", // 파주
] as const;

// 일반 매매 실거래 (RTMSDataSvcAptTrade). TradeDev(상세)는 별도 활용신청 필요.
export const TRADE_API_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";
export const RENT_API_URL =
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent";
export const PAGE_SIZE = 15;

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
