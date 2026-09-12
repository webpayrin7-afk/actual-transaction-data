/**
 * Client-safe apt types + href helpers.
 * Keep free of node:fs / DB / MOLIT server imports so "use client" modules
 * can import without pulling the server apt graph into the browser bundle.
 */
import { formatEok } from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";

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
