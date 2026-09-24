/**
 * 실거래 월간 사전 집계(market_monthly_deal_stats) 공통 정의.
 * 빌드 스크립트·서버 조회·클라이언트 화면이 같이 쓰므로 server-only가 아니다.
 */
import { seoulToday } from "@/lib/market/time";
import type { TrendRegion } from "@/lib/market/trends-regions";

export const DEAL_STATS_TABLE = "market_monthly_deal_stats";
/** 집계 방식이 바뀌면 올린다 — 행마다 기록된다. */
export const DEAL_STATS_BUILD_VERSION = "mds-v1";

/** 신고 기한: 계약 후 30일. 이 기한이 지나지 않은 달은 덜 집계돼 제외한다. */
export const REPORTING_LAG_DAYS = 30;

export type DealKind = "trade" | "jeonse";
export type AreaBand = "all" | "small" | "mid" | "large";
export type DealStatsScope = "lawd" | "dong" | "region";

export const DEAL_KINDS: DealKind[] = ["trade", "jeonse"];
export const AREA_BANDS: AreaBand[] = ["all", "small", "mid", "large"];

export const AREA_BAND_LABELS: Record<AreaBand, string> = {
  all: "전체 면적",
  small: "60㎡ 미만",
  mid: "60~85㎡",
  large: "85㎡ 초과",
};

/** 전용면적(㎡) → 면적대. 면적이 없으면(0) null. */
export function areaBandOf(area: number): Exclude<AreaBand, "all"> | null {
  if (!(area > 0)) return null;
  if (area < 60) return "small";
  if (area <= 85) return "mid";
  return "large";
}

/** 가격대 경계 (만원, 하한 포함·상한 미포함). band_0 … band_6 열에 대응한다. */
export const PRICE_BAND_EDGES: Record<DealKind, number[]> = {
  // <3억, 3~6억, 6~9억, 9~12억, 12~15억, 15~20억, 20억 이상
  trade: [30000, 60000, 90000, 120000, 150000, 200000],
  // <1억, 1~2억, 2~3억, 3~4억, 4~6억, 6~8억, 8억 이상
  jeonse: [10000, 20000, 30000, 40000, 60000, 80000],
};

export const PRICE_BAND_COUNT = 7;

export const PRICE_BAND_LABELS: Record<DealKind, string[]> = {
  trade: ["3억 미만", "3~6억", "6~9억", "9~12억", "12~15억", "15~20억", "20억 이상"],
  jeonse: ["1억 미만", "1~2억", "2~3억", "3~4억", "4~6억", "6~8억", "8억 이상"],
};

export function priceBandIndex(kind: DealKind, manwon: number): number {
  const edges = PRICE_BAND_EDGES[kind];
  let i = 0;
  while (i < edges.length && manwon >= edges[i]!) i++;
  return i;
}

/** 1평 = 3.3058㎡ */
export const PYEONG_M2 = 3.3058;

export function ymIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

export function ymFromIndex(i: number): string {
  return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`;
}

export function ymShift(ym: string, months: number): string {
  return ymFromIndex(ymIndex(ym) + months);
}

/** 오늘(서울) 기준 신고 기한이 지난 마지막 계약월. */
export function lastCompleteVolumeMonth(today = seoulToday()): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const cutoff = new Date(Date.UTC(y, m - 1, d) - REPORTING_LAG_DAYS * 86_400_000);
  // cutoff 날짜가 속한 달의 전달까지는 말일 + 30일이 지났다.
  return ymFromIndex(cutoff.getUTCFullYear() * 12 + cutoff.getUTCMonth() - 1);
}

/** 동 범위 키 — regionScopeKey와 같은 모양 ("11710|잠실동"). */
export function dongScopeKey(lawdCd: string, dong: string): string {
  return `${lawdCd}|${dong}`;
}

/**
 * 시장 흐름 지역 → 사전집계 키.
 * 시군구 하나는 lawd(그 구 실거래의 중위값).
 * 여러 시군구(전국·수도권·시도)는 region. 빌드가 소속 거래를 모아 계산한 중위값이라
 * 구별 중위가를 평균 낸 값이 아니다.
 */
export function dealStatsTargetForRegion(region: TrendRegion): {
  scope: "lawd" | "region";
  scopeKey: string;
  medianMethod: "pooled" | "single";
} | null {
  if (!region.lawdRanges?.length) return null;
  const only = region.lawdRanges.length === 1 ? region.lawdRanges[0] : null;
  if (only && only[0] === only[1]) {
    return { scope: "lawd", scopeKey: only[0], medianMethod: "single" };
  }
  return { scope: "region", scopeKey: region.id, medianMethod: "pooled" };
}

export type DealStatsPoint = {
  ym: string;
  kind: DealKind;
  area: AreaBand;
  count: number;
  median: number | null;
  ppp: number | null;
  /** 가격대 7칸 건수. PRICE_BAND_LABELS[kind]와 같은 순서. */
  bands: number[];
};

export type DealStatsPayload = {
  status: "ok";
  scope: DealStatsScope;
  scopeKey: string;
  medianMethod: "pooled" | "single";
  points: DealStatsPoint[];
  from: string | null;
  to: string | null;
  note?: string;
};

export const DEAL_STATS_DDL = `
CREATE TABLE IF NOT EXISTS ${DEAL_STATS_TABLE} (
  scope TEXT NOT NULL CHECK (scope IN ('lawd', 'dong', 'region')),
  scope_key TEXT NOT NULL,
  deal_kind TEXT NOT NULL CHECK (deal_kind IN ('trade', 'jeonse')),
  area_band TEXT NOT NULL CHECK (area_band IN ('all', 'small', 'mid', 'large')),
  year_month TEXT NOT NULL,
  deal_count INTEGER NOT NULL,
  median_price INTEGER,
  p25_price INTEGER,
  p75_price INTEGER,
  area_count INTEGER NOT NULL DEFAULT 0,
  median_ppp INTEGER,
  p25_ppp INTEGER,
  p75_ppp INTEGER,
  band_0 INTEGER NOT NULL DEFAULT 0,
  band_1 INTEGER NOT NULL DEFAULT 0,
  band_2 INTEGER NOT NULL DEFAULT 0,
  band_3 INTEGER NOT NULL DEFAULT 0,
  band_4 INTEGER NOT NULL DEFAULT 0,
  band_5 INTEGER NOT NULL DEFAULT 0,
  band_6 INTEGER NOT NULL DEFAULT 0,
  build_version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_key, deal_kind, area_band, year_month)
);
CREATE INDEX IF NOT EXISTS idx_${DEAL_STATS_TABLE}_ym ON ${DEAL_STATS_TABLE} (year_month);
`;
