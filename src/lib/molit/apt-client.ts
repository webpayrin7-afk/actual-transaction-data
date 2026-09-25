/**
 * Client-safe apt types + href helpers.
 * Keep free of node:fs / DB / MOLIT server imports so "use client" modules
 * can import without pulling the server apt graph into the browser bundle.
 */
import { formatEok } from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";

/**
 * 단지 상세·거래 API 응답 모양이 바뀌면 올린다 — 브라우저 캐시(max-age)에 남은 예전 응답을 안 쓰게 요청 주소에 붙인다.
 * 2: 평형 묶기(전용 소수점 차이를 한 평형으로)
 * 3: /api/apt-detail items를 압축 형식(itemsPacked)으로 — v<3 요청(예전 화면)은 기존 items 그대로
 */
export const APT_API_VERSION = "3";

export interface AptSuggestion {
  aptName: string;
  regionSlug: string;
  regionName: string;
  gu: string;
  dong: string;
  dealCount: number;
  maxDealAmount: number;
  latestDealDate: string;
}

export interface AptAreaOption {
  key: string;
  label: string;
  exclusiveArea: number;
  count: number;
  /** Phase 5 pilot: market-group selector for A/B complexes */
  selectorKind?: "exclusive" | "market_group";
  exclusiveAreaMin?: number;
  exclusiveAreaMax?: number;
  /** Phase 5 supply-area range (㎡); used for representative 평형 label */
  supplyAreaMin?: number | null;
  supplyAreaMax?: number | null;
  secondaryLabel?: string | null;
  marketLabel?: number | null;
  /** 이 평형의 세대수 (단지 타입 자료 합계) — 모르면 없음 */
  households?: number | null;
  /** 이 평형의 가장 최근 매매 실거래 (단지 상세가 불러온 거래에서) */
  latestTrade?: { amount: number; date: string; singoga: boolean } | null;
}

export interface AptHistoryItem extends Transaction {
  isSingoga: boolean;
  pyeong: number;
}

export interface AptChartPoint {
  yearMonth: string; // YYYYMM
  label: string; // YY.MM
  tradeAvg: number | null;
  tradeMax: number | null;
  tradeCount: number;
  jeonseAvg: number | null;
  jeonseCount: number;
  wolseCount: number;
  volume: number;
}

export interface AptDetailResponse {
  aptName: string;
  regionSlug: string;
  regionName: string;
  fullName: string;
  gu: string;
  dong: string;
  buildYear: number | null;
  source: "api" | "mock" | "db";
  yearMonth: string;
  warning?: string;
  /** 최근 N개월만 먼저 내려준 부분 응답 */
  partial?: boolean;
  loadedMonths: number;
  stats: {
    recent3mCount: number;
    maxDealAmount: number;
    avgDealAmount: number;
    totalTradeCount: number;
    totalRentCount: number;
  };
  areas: AptAreaOption[];
  chart: AptChartPoint[];
  items: AptHistoryItem[];
  /** Phase 5 pilot metadata; absent for non-pilot complexes */
  unitTypePilot?: {
    complexKey: string;
    classification: string;
    singogaMode: string;
    selectorMode: "market_group" | "exclusive";
  } | null;
}

export function aptDetailHref(
  aptName: string,
  regionSlug: string,
  gu?: string,
): string {
  const qs = new URLSearchParams({ region: regionSlug });
  if (gu?.trim()) qs.set("gu", gu.trim());
  return `/apt/${encodeURIComponent(aptName)}?${qs.toString()}`;
}

export function formatAptPriceLabel(manwon: number): string {
  return formatEok(manwon);
}
