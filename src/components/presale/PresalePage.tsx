"use client";

import { useState } from "react";
import { METRO_LABELS } from "@/lib/constants/regions";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  ApplyhomeCompetitionSection,
  ApplyhomeHistorySection,
  ApplyhomeUpcomingSection,
  type PresaleMetro,
} from "@/components/presale/ApplyhomeSections";
import { MoveInSection } from "@/components/presale/MoveInSection";

const METRO_ORDER = [
  "seoul", "gyeonggi", "incheon", "busan", "daegu", "gwangju", "daejeon", "ulsan", "sejong",
  "gangwon", "chungbuk", "chungnam", "jeonbuk", "jeonnam", "gyeongbuk", "gyeongnam", "jeju",
] as const;

const METRO_TABS = [
  { id: "all", label: "전국" },
  ...METRO_ORDER.map((m) => ({ id: m as string, label: METRO_LABELS[m] })),
];

/**
 * 분양 — 청약 일정 · 최근 청약 경쟁률 · 입주 예정 · 지난 청약 결과 (한국부동산원 청약홈 공고 사본).
 * 위 시·도 선택이 모든 섹션을 좁힌다.
 */
export function PresalePage() {
  const [metro, setMetro] = useState<PresaleMetro>("all");
  const pick = (m: string) => {
    setMetro(m);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={PAGE_SHELL}>
      <PageHeader title="분양" titleClassName="detail-page-title" showDivider={false}>
        <LabTabs variant="secondary" ariaLabel="시·도" columns={6} items={METRO_TABS} value={metro} onChange={setMetro} />
      </PageHeader>
      <ApplyhomeUpcomingSection metro={metro} />
      <ApplyhomeCompetitionSection metro={metro} />
      <MoveInSection metro={metro} onPickMetro={pick} />
      <ApplyhomeHistorySection metro={metro} />
    </div>
  );
}
