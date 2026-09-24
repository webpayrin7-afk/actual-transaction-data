"use client";

import { useState } from "react";
import { METRO_LABELS } from "@/lib/constants/regions";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabTabs, labTabPanelId } from "@/components/ui/LabTabs";
import {
  ApplyhomeCompetitionSection,
  ApplyhomeUpcomingSection,
  type PresaleMetro,
  type PresaleSupplier,
} from "@/components/presale/ApplyhomeSections";
import { MoveInSection } from "@/components/presale/MoveInSection";
import { PresaleResults } from "@/components/presale/PresaleResults";

const METRO_ORDER = [
  "seoul", "gyeonggi", "incheon", "busan", "daegu", "gwangju", "daejeon", "ulsan", "sejong",
  "gangwon", "chungbuk", "chungnam", "jeonbuk", "jeonnam", "gyeongbuk", "gyeongnam", "jeju",
] as const;

const METRO_TABS = [
  { id: "all", label: "전국" },
  ...METRO_ORDER.map((m) => ({ id: m as string, label: METRO_LABELS[m] })),
];

type PresaleTab = "schedule" | "results";
const TABS = [
  { id: "schedule" as const, label: "청약 일정" },
  { id: "results" as const, label: "분양 결과" },
];
const SUPPLIER_TABS = [
  { id: "all" as const, label: "전체" },
  { id: "private" as const, label: "민간" },
  { id: "public" as const, label: "공공" },
];
const TAB_PREFIX = "presale";

/**
 * 분양 — [청약 일정 | 분양 결과] (한국부동산원 청약홈 공고 사본).
 * 시·도와 공급(민간·공공) 선택이 두 탭 모두를 좁힌다.
 */
export function PresalePage() {
  const [tab, setTab] = useState<PresaleTab>("schedule");
  const [metro, setMetro] = useState<PresaleMetro>("all");
  const [supplier, setSupplier] = useState<PresaleSupplier>("all");
  const filter = { metro, supplier };
  const pickMetro = (m: string) => {
    setMetro(m);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={PAGE_SHELL}>
      <PageHeader title="분양" titleClassName="detail-page-title" showDivider={false}>
        <div className="flex flex-col gap-2">
          <LabTabs variant="primary" ariaLabel="분양 보기" idPrefix={TAB_PREFIX} items={TABS} value={tab} onChange={setTab} />
          <LabTabs variant="secondary" ariaLabel="시·도" columns={6} items={METRO_TABS} value={metro} onChange={setMetro} />
          <LabTabs variant="compact" ariaLabel="공급" items={SUPPLIER_TABS} value={supplier} onChange={setSupplier} />
        </div>
      </PageHeader>

      <div id={labTabPanelId(TAB_PREFIX, tab)} role="tabpanel" className="flex flex-col gap-5 sm:gap-6">
        {tab === "schedule" ? (
          <>
            <ApplyhomeUpcomingSection filter={filter} />
            <ApplyhomeCompetitionSection filter={filter} />
            <MoveInSection metro={metro} onPickMetro={pickMetro} />
          </>
        ) : (
          <PresaleResults metro={metro} supplier={supplier} />
        )}
      </div>
    </div>
  );
}
