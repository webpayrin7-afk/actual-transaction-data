"use client";

import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";

type RegionJeonseLatest = {
  status?: string;
  asOfMonth?: string;
  latest?: { jeonseRatio: number | null; pairCount: number };
};

/**
 * 이 단지 전세가율 vs 같은 구 중위 전세가율 — 한 줄 요약 (policy §12.5).
 * 구 값은 region_jeonse(최근 3개월 단지·면적 쌍 중위)를 읽기만 한다.
 */
export function ComplexJeonseBenchmark({
  lawdCd,
  regionName,
  complexRatioPct,
}: {
  lawdCd: string | null;
  regionName: string | null;
  /** 이 단지 (선택 면적) 최근 전세 ÷ 최근 매매, % */
  complexRatioPct: number | null;
}) {
  const query = useQuery({
    queryKey: ["region-jeonse", lawdCd],
    queryFn: async (): Promise<RegionJeonseLatest> => {
      const res = await fetch(`/api/region-jeonse?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("region-jeonse");
      return res.json();
    },
    enabled: Boolean(lawdCd),
    staleTime: 60 * 60 * 1000,
  });

  const regionRatio = query.data?.latest?.jeonseRatio;
  if (!lawdCd || regionRatio == null || !regionName) return null;
  const regionPct = Math.round(regionRatio * 100);
  const diff = complexRatioPct == null ? null : Math.round(complexRatioPct - regionPct);
  const asOf = query.data?.asOfMonth;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="detail-label inline-flex items-center">
        {regionName} 전세가율
        <InfoTip aria-label="지역 전세가율 안내">
          {regionName}에서 최근 3개월 매매·전세가 모두 있는 단지·면적의 전세가율 중위값입니다
          {asOf ? ` (${asOf.slice(0, 4)}.${asOf.slice(4, 6)} 기준)` : ""}. 이 단지 값은 선택
          면적의 가장 최근 매매와 전세로 계산해 기준이 다를 수 있습니다.
        </InfoTip>
      </p>
      <p className="detail-data-value-emphasis tabular-nums">
        {regionPct}%
        {diff != null && diff !== 0 ? (
          <span className="detail-meta ml-1.5">
            이 단지 {diff > 0 ? "+" : "−"}
            {Math.abs(diff)}%p
          </span>
        ) : null}
      </p>
    </div>
  );
}
