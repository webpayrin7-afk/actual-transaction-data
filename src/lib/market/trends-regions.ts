import { SEOUL_REGIONS } from "@/lib/constants/regions";

/**
 * 시장 동향(/stats) 지역 목록.
 * - clsId: 한국부동산원 R-ONE 전국주택가격동향조사 지역 분류 ID (매매·전세지수, 중위가격, 전세가율 공통)
 * - lawdRanges: 거래량(국토교통부 실거래 신고, 계약월) 집계에 쓰는 시군구 코드 범위(포함).
 *   null이면 행정구역이 R-ONE 분류와 1:1로 맞지 않아 거래량을 보여주지 않는다.
 */
export type TrendRegionGroup = "wide" | "sido" | "seoul";

export type TrendRegion = {
  id: string;
  label: string;
  /** 목록·제목에서 상위 지역과 함께 쓰는 이름 (e.g. "서울 강남구") */
  fullLabel: string;
  clsId: number;
  group: TrendRegionGroup;
  lawdRanges: Array<[string, string]> | null;
  /** 거래량을 보여줄 수 없을 때 이유 */
  volumeNote?: string;
  /** 지역 상세 페이지 slug (서울 구) */
  regionSlug?: string;
};

function prefix(p: string): [string, string] {
  return [`${p}000`, `${p}999`];
}

const MERGED_NOTE =
  "광주·전남은 2026년 행정구역 통합으로 시군구 코드가 바뀌어 거래량을 나눠 집계할 수 없습니다.";

const WIDE: TrendRegion[] = [
  { id: "all", label: "전국", fullLabel: "전국", clsId: 500001, group: "wide", lawdRanges: [["00000", "99999"]] },
  {
    id: "capital",
    label: "수도권",
    fullLabel: "수도권",
    clsId: 500002,
    group: "wide",
    lawdRanges: [prefix("11"), prefix("28"), prefix("41")],
  },
  {
    id: "local",
    label: "지방",
    fullLabel: "지방",
    clsId: 500003,
    group: "wide",
    lawdRanges: [
      ["12000", "27999"],
      ["29000", "40999"],
      ["42000", "99999"],
    ],
  },
];

const SIDO: TrendRegion[] = (
  [
    ["seoul", "서울", 500008, "11"],
    ["gyeonggi", "경기", 500009, "41"],
    ["incheon", "인천", 500010, "28"],
    ["busan", "부산", 500011, "26"],
    ["daegu", "대구", 500012, "27"],
    ["gwangju", "광주", 500013, null],
    ["daejeon", "대전", 500014, "30"],
    ["ulsan", "울산", 500015, "31"],
    ["sejong", "세종", 500016, "36"],
    ["gangwon", "강원", 500017, "51"],
    ["chungbuk", "충북", 500018, "43"],
    ["chungnam", "충남", 500019, "44"],
    ["jeonbuk", "전북", 500020, "52"],
    ["jeonnam", "전남", 500021, null],
    ["gyeongbuk", "경북", 500022, "47"],
    ["gyeongnam", "경남", 500023, "48"],
    ["jeju", "제주", 500024, "50"],
  ] as const
).map(([id, label, clsId, p]) => ({
  id,
  label,
  fullLabel: label,
  clsId,
  group: "sido" as const,
  lawdRanges: p ? [prefix(p)] : null,
  volumeNote: p ? undefined : MERGED_NOTE,
}));

/** R-ONE 서울 구 분류 ID (2026.08 기준 목록). */
const SEOUL_GU_CLS: Record<string, number> = {
  종로구: 530011,
  중구: 530012,
  용산구: 530013,
  성동구: 530015,
  광진구: 530016,
  동대문구: 530017,
  중랑구: 530018,
  성북구: 530019,
  강북구: 530020,
  도봉구: 530021,
  노원구: 530022,
  은평구: 530024,
  서대문구: 530025,
  마포구: 530026,
  양천구: 530029,
  강서구: 530030,
  구로구: 530031,
  금천구: 530032,
  영등포구: 530033,
  동작구: 530034,
  관악구: 530035,
  서초구: 530037,
  강남구: 530038,
  송파구: 530039,
  강동구: 530040,
};

const SEOUL_GU: TrendRegion[] = SEOUL_REGIONS.flatMap((r) => {
  const clsId = SEOUL_GU_CLS[r.name];
  const code = r.lawdCodes[0];
  if (!clsId || !code) return [];
  return [
    {
      id: r.slug,
      label: r.name,
      fullLabel: `서울 ${r.name}`,
      clsId,
      group: "seoul" as const,
      lawdRanges: [[code, code]] as Array<[string, string]>,
      regionSlug: r.slug,
    },
  ];
});

export const TREND_REGIONS: TrendRegion[] = [...WIDE, ...SIDO, ...SEOUL_GU];

export const TREND_REGION_GROUPS: Array<{ id: TrendRegionGroup; label: string }> = [
  { id: "wide", label: "권역" },
  { id: "sido", label: "시도" },
  { id: "seoul", label: "서울 구" },
];

export const DEFAULT_TREND_REGION = "all";

export function trendRegionById(id: string | null | undefined): TrendRegion | null {
  if (!id) return null;
  return TREND_REGIONS.find((r) => r.id === id) ?? null;
}

export function trendRegionsOf(group: TrendRegionGroup): TrendRegion[] {
  return TREND_REGIONS.filter((r) => r.group === group);
}

export type TrendPeriod = "3y" | "5y" | "10y" | "all";

export const TREND_PERIODS: Array<{ id: TrendPeriod; label: string }> = [
  { id: "3y", label: "3년" },
  { id: "5y", label: "5년" },
  { id: "10y", label: "10년" },
  { id: "all", label: "전체" },
];

export const TREND_PERIOD_MONTHS: Record<TrendPeriod, number | null> = {
  "3y": 36,
  "5y": 60,
  "10y": 120,
  all: null,
};

export function isTrendPeriod(v: string | null): v is TrendPeriod {
  return v === "3y" || v === "5y" || v === "10y" || v === "all";
}
