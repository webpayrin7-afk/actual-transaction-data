"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { TrendsPriceIndexSection } from "@/components/stats/TrendsPriceIndexSection";
import type { TrendSeries } from "@/lib/market/trends";
import { DEFAULT_TREND_REGION, trendRegionById } from "@/lib/market/trends-regions";

async function fetchNationalTrend(): Promise<TrendSeries> {
  const res = await fetch(`/api/market-trends?region=${encodeURIComponent(DEFAULT_TREND_REGION)}`);
  if (!res.ok) throw new Error("시장 흐름을 불러오지 못했습니다.");
  return res.json();
}

/**
 * 시장 홈 — 오늘 이슈 아래에 붙는 장기 흐름 요약 (전국 매매·전세지수, 최근 3년).
 * 지역·기간 선택과 거래량·가격 수준은 /stats(시장 흐름)에서 본다. 같은 쿼리 키라 캐시를 공유한다.
 */
export function MarketFlowSummary() {
  const query = useQuery({
    queryKey: ["market-trends", DEFAULT_TREND_REGION],
    queryFn: fetchNationalTrend,
    staleTime: 60 * 60 * 1000,
  });
  const regionLabel = trendRegionById(DEFAULT_TREND_REGION)?.label ?? "전국";

  return (
    <div className="flex flex-col gap-3">
      <TrendsPriceIndexSection
        regionLabel={regionLabel}
        tradeIndex={query.data?.tradeIndex ?? null}
        jeonseIndex={query.data?.jeonseIndex ?? null}
        period="3y"
        loading={query.isLoading}
        error={query.isError}
        onRetry={() => void query.refetch()}
      />
      <Link href="/stats" className="lab-button lab-button-secondary w-full">
        지역별 · 장기 시장 흐름 보기
        <span aria-hidden className="ml-1">
          →
        </span>
      </Link>
    </div>
  );
}
