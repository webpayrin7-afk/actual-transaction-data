"use client";

import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { RecentComplexList } from "@/components/complexes/RecentComplexList";
import { SavedComplexList } from "@/components/complexes/SavedComplexList";
import { GuLeaderList } from "@/components/complexes/GuLeaderList";
import { ActiveComplexList } from "@/components/complexes/ActiveComplexList";
import { PAGE_SHELL_MENU as PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

/**
 * 단지별 조회 = 검색 · 다시보기 · 단지 발견.
 * 지역 탐색(/regions) · 시장 이벤트 랭킹(/ · /stats)과 역할을 겹치지 않는다.
 */
export function ComplexesPage() {
  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="단지별 조회"
        titleClassName="detail-page-title"
        showDivider={false}
        titleInHeader
      >
        <AptQuickSearch
          inputId="complexes-search"
          placeholder="아파트 단지명을 검색하세요."
          showPrice={false}
        />
      </PageHeader>

      <SavedComplexList />

      <RecentComplexList />

      <GuLeaderList />


      <ActiveComplexList />
    </div>
  );
}
