"use client";

import { useQuery } from "@tanstack/react-query";
import {
  regionScopeKey,
  regionScopeParams,
  type RegionScope,
} from "@/lib/region/region-scope";
import type { RegionMarketDetail } from "@/lib/region/region-market-detail";
import type { RegionPriceTrend } from "@/lib/region/region-price-trend";
import type { RegionJeonse } from "@/lib/region/region-jeonse";
import type { RegionAptSummary } from "@/lib/region/region-summary";
import type { RegionDongOverview } from "@/lib/region/region-dong-overview";

/**
 * 구·동 공통 섹션 데이터 훅. 쿼리 키는 `regionScopeKey`라 구 범위는
 * 기존 키(["…", lawdCd])와 같고, 같은 범위의 섹션끼리 요청을 공유한다.
 */
async function getJson<T>(path: string, scope: RegionScope, label: string): Promise<T> {
  const res = await fetch(`${path}?${regionScopeParams(scope)}`);
  if (!res.ok) throw new Error(label);
  return (await res.json()) as T;
}

export function useRegionMarketDetail(scope: RegionScope | null) {
  return useQuery({
    queryKey: ["region-market-detail", scope ? regionScopeKey(scope) : null],
    queryFn: () => getJson<RegionMarketDetail>("/api/region-market-detail", scope!, "detail"),
    enabled: !!scope,
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

export function useRegionPriceTrend(scope: RegionScope | null) {
  return useQuery({
    queryKey: ["region-price-trend", scope ? regionScopeKey(scope) : null],
    queryFn: () => getJson<RegionPriceTrend>("/api/region-price-trend", scope!, "trend"),
    enabled: !!scope,
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

export function useRegionJeonse(scope: RegionScope) {
  return useQuery({
    queryKey: ["region-jeonse", regionScopeKey(scope)],
    queryFn: () => getJson<RegionJeonse>("/api/region-jeonse", scope, "jeonse"),
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

export function useRegionSummary(scope: RegionScope | null) {
  return useQuery({
    queryKey: ["region-summary", scope ? regionScopeKey(scope) : null],
    queryFn: () => getJson<RegionAptSummary>("/api/region-summary", scope!, "summary"),
    enabled: !!scope,
    staleTime: 60 * 60_000,
    retry: 1,
  });
}

/** 동 전용: 단지 목록 · 지도 좌표 · 최근 거래. */
export function useRegionDongOverview(scope: RegionScope & { dong: string }) {
  return useQuery({
    queryKey: ["region-dong-overview", regionScopeKey(scope)],
    queryFn: () => getJson<RegionDongOverview>("/api/region-dong-overview", scope, "overview"),
    staleTime: 10 * 60_000,
    retry: 1,
  });
}
