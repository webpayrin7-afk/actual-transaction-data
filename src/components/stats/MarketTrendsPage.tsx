"use client";

import { useCallback, useId, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSectionBoundary } from "@/components/ui/LabSectionBoundary";
import { LabTabs } from "@/components/ui/LabTabs";
import { LabTextLink } from "@/components/ui/LabListRow";
import { TrendsPriceIndexSection } from "@/components/stats/TrendsPriceIndexSection";
import { TrendsVolumeSection } from "@/components/stats/TrendsVolumeSection";
import { TrendsPriceLevelSection } from "@/components/stats/TrendsPriceLevelSection";
import { TrendsRegionCompareSection } from "@/components/stats/TrendsRegionCompareSection";
import { TrendsDealPriceSection } from "@/components/stats/TrendsDealPriceSection";
import { TrendsDealMixSection } from "@/components/stats/TrendsDealMixSection";
import type { TrendSeries } from "@/lib/market/trends";
import type { DealStatsPayload } from "@/lib/market/deal-stats";
import {
  DEFAULT_TREND_REGION,
  TREND_PERIODS,
  TREND_REGION_GROUPS,
  isTrendPeriod,
  trendRegionById,
  trendRegionsOf,
  type TrendPeriod,
} from "@/lib/market/trends-regions";

const DEFAULT_PERIOD: TrendPeriod = "10y";

async function fetchSeries(regionId: string): Promise<TrendSeries> {
  const res = await fetch(`/api/market-trends?region=${encodeURIComponent(regionId)}`);
  if (!res.ok) throw new Error("시장 동향을 불러오지 못했습니다.");
  return res.json();
}

async function fetchDealStats(regionId: string): Promise<DealStatsPayload> {
  const res = await fetch(`/api/market-deal-stats?region=${encodeURIComponent(regionId)}`);
  if (!res.ok) throw new Error("실거래 집계를 불러오지 못했습니다.");
  return res.json();
}

function RegionSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-[16rem]">
      <label htmlFor={id} className="detail-label">
        지역
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="lab-input h-12 appearance-none pr-10 pl-3 text-[16px] font-medium"
        >
          {TREND_REGION_GROUPS.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {trendRegionsOf(g.id).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullLabel}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 h-5 w-5 -translate-y-1/2 text-[color:var(--lab-muted)]"
          aria-hidden
        />
      </div>
    </div>
  );
}

export function MarketTrendsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [regionId, setRegionId] = useState<string>(
    () => trendRegionById(searchParams.get("region"))?.id ?? DEFAULT_TREND_REGION,
  );
  const [period, setPeriod] = useState<TrendPeriod>(() => {
    const p = searchParams.get("period");
    return isTrendPeriod(p) ? p : DEFAULT_PERIOD;
  });
  const region = trendRegionById(regionId) ?? trendRegionById(DEFAULT_TREND_REGION)!;

  const syncUrl = useCallback(
    (nextRegion: string, nextPeriod: TrendPeriod) => {
      const params = new URLSearchParams();
      if (nextRegion !== DEFAULT_TREND_REGION) params.set("region", nextRegion);
      if (nextPeriod !== DEFAULT_PERIOD) params.set("period", nextPeriod);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const changeRegion = (next: string) => {
    setRegionId(next);
    syncUrl(next, period);
  };
  const changePeriod = (next: TrendPeriod) => {
    setPeriod(next);
    syncUrl(regionId, next);
  };
  const selectFromList = (next: string) => {
    changeRegion(next);
    document.getElementById("trends-controls")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const query = useQuery({
    queryKey: ["market-trends", regionId],
    queryFn: () => fetchSeries(regionId),
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const dealQuery = useQuery({
    queryKey: ["market-deal-stats", regionId],
    queryFn: () => fetchDealStats(regionId),
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const data = query.data?.regionId === regionId ? query.data : undefined;
  const deal = dealQuery.data?.scopeKey ? dealQuery.data : undefined;
  const loading = query.isLoading;
  const error = query.isError;
  const retry = () => void query.refetch();
  const dealLoading = dealQuery.isLoading;
  const dealError = dealQuery.isError;
  const retryDeal = () => void dealQuery.refetch();
  useLoadProgressWhen((loading && !data) || (dealLoading && !deal), "시장 동향 불러오는 중…");

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="시장 흐름"
        titleClassName="detail-page-title"
        showDivider={false}
        titleTip={
          <p>
            한국부동산원 가격지수와 국토교통부 실거래로 아파트 시장의 장기 흐름을 봅니다. 실거래 중위가·평당가·가격대는
            미리 모아 둔 월간 집계입니다.
          </p>
        }
      />

      <div
        id="trends-controls"
        className="flex scroll-mt-[calc(var(--site-header-height,53px)+8px)] flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
      >
        <RegionSelect value={regionId} onChange={changeRegion} />
        <div className="flex flex-col items-start gap-1">
          <span className="detail-label">그래프 기간</span>
          <LabTabs
            variant="compact"
            items={TREND_PERIODS}
            value={period}
            onChange={changePeriod}
            ariaLabel="그래프 기간"
          />
        </div>
      </div>
      {region.regionSlug ? (
        <div className="-mt-2">
          <LabTextLink href={`/region/${region.regionSlug}`}>{region.label} 지역 상세 보기</LabTextLink>
        </div>
      ) : null}

      <LabSectionBoundary id="price-index" title="가격 흐름">
        <TrendsPriceIndexSection
          regionLabel={region.fullLabel}
          tradeIndex={data?.tradeIndex ?? null}
          jeonseIndex={data?.jeonseIndex ?? null}
          period={period}
          loading={loading}
          error={error || (!!data && !data.tradeIndex)}
          onRetry={retry}
        />
      </LabSectionBoundary>

      <LabSectionBoundary id="deal-price" title="실거래 가격">
        <TrendsDealPriceSection
          regionLabel={region.fullLabel}
          data={deal ?? null}
          period={period}
          loading={dealLoading}
          error={dealError}
          onRetry={retryDeal}
        />
      </LabSectionBoundary>

      <LabSectionBoundary id="deal-mix" title="가격대 구성">
        <TrendsDealMixSection
          regionLabel={region.fullLabel}
          data={deal ?? null}
          period={period}
          loading={dealLoading}
          error={dealError}
          onRetry={retryDeal}
        />
      </LabSectionBoundary>

      <LabSectionBoundary id="volume" title="거래량 흐름">
        <TrendsVolumeSection
          key={regionId}
          regionLabel={region.fullLabel}
          volume={data?.volume}
          period={period}
          loading={loading}
          error={error}
          onRetry={retry}
        />
      </LabSectionBoundary>

      <div className="grid grid-cols-1 gap-3 sm:gap-6 lg:grid-cols-2 lg:items-start">
        <LabSectionBoundary id="price-level" title="가격 수준">
          <TrendsPriceLevelSection
            regionLabel={region.fullLabel}
            medianTradePrice={data?.medianTradePrice ?? null}
            jeonseRatio={data?.jeonseRatio ?? null}
            period={period}
            loading={loading}
            error={error || (!!data && !data.medianTradePrice && !data.jeonseRatio)}
            onRetry={retry}
          />
        </LabSectionBoundary>

        <LabSectionBoundary id="region-compare" title="지역별 장기 변동">
          <TrendsRegionCompareSection
            selectedRegionId={regionId}
            initialGroup={region.group === "seoul" ? "seoul" : "sido"}
            onSelect={selectFromList}
          />
        </LabSectionBoundary>
      </div>

      <div className="flex flex-wrap gap-x-4">
        <LabTextLink href="/">오늘의 시장</LabTextLink>
        <LabTextLink href="/regions">지역 조회</LabTextLink>
      </div>
    </div>
  );
}
