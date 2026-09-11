"use client";

import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { RecentComplexList } from "@/components/complexes/RecentComplexList";
import { ActiveComplexList } from "@/components/complexes/ActiveComplexList";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

/**
 * 단지 조회 = 검색 · 다시보기 · 단지 발견.
 * 지역 탐색(/regions) · 시장 이벤트 랭킹(/ · /stats)과 역할을 겹치지 않는다.
 */
export function ComplexesPage() {
  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="단지 조회"
        description="궁금한 아파트를 검색하고 실거래가와 거래 이력을 확인하세요."
      >
        <AptQuickSearch
          inputId="complexes-search"
          placeholder="아파트 단지 또는 지역을 검색하세요."
          emptySubmitHref="/complexes"
          showPrice={false}
          includeRegions
          hint="단지는 상세로, 지역은 지역 상세로 이동합니다. 동명이 있으면 지역·동으로 구분됩니다."
        />
      </PageHeader>

      <RecentComplexList />

      <ActiveComplexList />
    </div>
  );
}
