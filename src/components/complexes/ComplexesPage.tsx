"use client";

import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { RecentComplexList } from "@/components/complexes/RecentComplexList";
import { RegionComplexBrowse } from "@/components/complexes/RegionComplexBrowse";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

/**
 * 단지 조회 = 아파트를 찾고 다시 찾는 시작점.
 * 시장 TOP 랭킹은 오늘의 시장·시장동향과 역할이 겹쳐 여기서는 보여주지 않는다.
 */
export function ComplexesPage() {
  return (
    <div className={`${PAGE_SHELL} gap-8`}>
      <PageHeader
        title="단지 조회"
        description="궁금한 아파트를 검색하고 실거래가와 거래 이력을 확인하세요."
      >
        <AptQuickSearch
          inputId="complexes-search"
          placeholder="아파트 단지명을 검색하세요"
          emptySubmitHref="/regions"
          showPrice={false}
          hint="동명이 있으면 지역·동으로 구분됩니다. 선택 시 단지 상세로 이동합니다."
        />
      </PageHeader>

      <RecentComplexList />

      <RegionComplexBrowse />

      <footer className="border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 OpenAPI 기반 · 아파트 데이터랩
      </footer>
    </div>
  );
}
