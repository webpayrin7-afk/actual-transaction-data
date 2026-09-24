"use client";

import { useRef } from "react";
import { BackLink } from "@/components/layout/BackLink";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSectionBoundary } from "@/components/ui/LabSectionBoundary";
import { RegionHeroMeta } from "@/components/region/RegionHeroMeta";
import { RegionStickyNav, DONG_MARKET_SECTIONS } from "@/components/region/RegionStickyNav";
import {
  RegionPriceSection,
  RegionRankingTable,
} from "@/components/region/RegionMarketSections";
import { RegionDongPricesSection } from "@/components/region/RegionDongPrices";
import { RegionJeonseSection } from "@/components/region/RegionJeonseSection";
import { RegionTradeHighlightsSection } from "@/components/region/RegionMarketExtras";
import { RegionDongComplexesSection } from "@/components/region/RegionDongComplexesSection";
import { RegionDongDealsSection } from "@/components/region/RegionDongDealsSection";
import {
  useRegionDongOverview,
  useRegionPriceTrend,
} from "@/components/region/useRegionScopeQueries";
import { rankingDongRegionCode } from "@/lib/region-ranking/public";
import type { RegionScope } from "@/lib/region/region-scope";

/**
 * 법정동 상세. 구 「시장 현황」 섹션을 동 범위(`{ lawdCd, dong }`)로 재사용하고,
 * 동 전용으로 주변 동 비교 · 단지 목록(지도) · 최근 거래를 둔다.
 */
export function RegionDongDetail({
  regionSlug,
  lawdCd,
  dong,
  guLabel,
  guName,
  locationLabel,
}: {
  regionSlug: string;
  lawdCd: string;
  dong: string;
  /** 화면 표기 구 이름 (예: 송파구, 수원시 장안구). */
  guLabel: string;
  /** 단지 상세 링크의 gu 파라미터 (구 페이지와 같은 값). */
  guName: string;
  /** 제목 위 소속 표기 (예: 서울특별시 송파구). */
  locationLabel: string;
}) {
  const scope: RegionScope & { dong: string } = { lawdCd, dong };
  const overview = useRegionDongOverview(scope);
  const trend = useRegionPriceTrend(scope);
  const bjdongCd = overview.data?.bjdongCd ?? trend.data?.dong?.bjdongCd ?? null;
  const rankingCode = rankingDongRegionCode(lawdCd, bjdongCd);
  const anchor = useRef<HTMLDivElement | null>(null);

  useLoadProgressWhen(overview.isLoading && !overview.data, "동 정보 불러오는 중…");

  return (
    <div className={PAGE_SHELL}>
      <header className="-mt-1 sm:-mt-1.5">
        <PageHeader
          leading={<BackLink fallback={`/region/${regionSlug}`} compact hideLabel />}
          eyebrow={<p className="detail-meta truncate">{locationLabel}</p>}
          title={dong}
          titleClassName="detail-page-title"
          showDivider={false}
        >
          <RegionHeroMeta scope={scope} />
        </PageHeader>
      </header>

      <div className="flex min-h-[min(70vh,42rem)] flex-col gap-3 sm:gap-5">
        <div ref={anchor} className="-mb-3 h-0 sm:-mb-5" aria-hidden />
        <RegionStickyNav
          anchor={anchor}
          title={dong}
          subtitle={guLabel}
          sections={DONG_MARKET_SECTIONS}
        />

        <LabSectionBoundary id="market-price" title="동 시세 평당가">
          <RegionPriceSection scope={scope} regionName={dong} />
        </LabSectionBoundary>

        <LabSectionBoundary id="market-compare" title="주변 동 비교">
          <RegionDongPricesSection
            lawdCd={lawdCd}
            regionName={guLabel}
            regionSlug={regionSlug}
            currentDong={dong}
            guLink={{ href: `/region/${regionSlug}`, label: `${guLabel} 시장 현황 보기` }}
          />
        </LabSectionBoundary>

        <LabSectionBoundary id="market-jeonse" title="전세가율 · 갭">
          <RegionJeonseSection
            scope={scope}
            regionSlug={regionSlug}
            regionName={guName}
            label={dong}
          />
        </LabSectionBoundary>

        <LabSectionBoundary id="market-trends" title="거래 동향">
          <RegionTradeHighlightsSection
            scope={scope}
            regionSlug={regionSlug}
            regionName={guName}
            label={dong}
          />
        </LabSectionBoundary>

        {rankingCode ? (
          <LabSectionBoundary id="region-ranking" title="동 아파트 랭킹">
            <RegionRankingTable
              regionSlug={regionSlug}
              regionName={guName}
              regionCode={rankingCode}
              title="동 아파트 랭킹"
              label={dong}
              emptyText="최근 1년 거래가 충분한 단지가 적어 이 동은 순위를 매기지 않았어요."
            />
          </LabSectionBoundary>
        ) : null}

        <RegionDongComplexesSection
          dong={dong}
          data={overview.data?.status === "ok" ? overview.data : null}
          loading={overview.isLoading}
          failed={overview.isError}
          regionSlug={regionSlug}
          guName={guName}
        />

        <RegionDongDealsSection
          dong={dong}
          data={overview.data?.status === "ok" ? overview.data : null}
          loading={overview.isLoading}
          failed={overview.isError}
          regionSlug={regionSlug}
          guName={guName}
        />
      </div>
    </div>
  );
}
