"use client";

import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { ApplyhomeCompetitionSection, ApplyhomeUpcomingSection } from "@/components/presale/ApplyhomeSections";

/**
 * 분양 — 청약 일정 · 최근 청약 경쟁률 (한국부동산원 청약홈 공고 사본).
 * 단지 조회(기존 단지 발견)·지역 조회(지역 비교)와 역할을 나눈다.
 */
export function PresalePage() {
  return (
    <div className={PAGE_SHELL}>
      <PageHeader title="분양" titleClassName="detail-page-title" showDivider={false} />
      <ApplyhomeUpcomingSection />
      <ApplyhomeCompetitionSection />
    </div>
  );
}
