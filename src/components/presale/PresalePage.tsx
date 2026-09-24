"use client";

import { useState } from "react";
import { METRO_LABELS } from "@/lib/constants/regions";
import type { ResultsQuery } from "@/lib/applyhome/read";
import { PAGE_SHELL_FLUSH as PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { labTabId, labTabPanelId } from "@/components/ui/LabTabs";
import { LabPageTabs } from "@/components/ui/LabPageTabs";
import {
  ApplyhomeCompetitionSection,
  ApplyhomeUpcomingSection,
  type PresaleMetro,
  type PresaleSupplier,
} from "@/components/presale/ApplyhomeSections";
import { MoveInSection } from "@/components/presale/MoveInSection";
import { AREA_OPTIONS, PRICE_OPTIONS, PresaleResults } from "@/components/presale/PresaleResults";
import { LabFilterChips, type FilterDef } from "@/components/ui/LabFilterChips";

const METRO_ORDER = [
  "seoul", "gyeonggi", "incheon", "busan", "daegu", "gwangju", "daejeon", "ulsan", "sejong",
  "gangwon", "chungbuk", "chungnam", "jeonbuk", "jeonnam", "gyeongbuk", "gyeongnam", "jeju",
] as const;

const METRO_OPTIONS = [
  { id: "all", label: "전국" },
  ...METRO_ORDER.map((m) => ({ id: m as string, label: METRO_LABELS[m] })),
];

const SUPPLIER_OPTIONS = [
  { id: "all", label: "전체" },
  { id: "private", label: "민간분양" },
  { id: "public", label: "공공분양" },
] as const;

type PresaleTab = "schedule" | "results" | "movein";
const TABS = [
  { id: "schedule" as const, label: "청약 일정" },
  { id: "results" as const, label: "분양 결과" },
  { id: "movein" as const, label: "입주 예정" },
];
const TAB_PREFIX = "presale";

/**
 * 분양 — [청약 일정 | 분양 결과 | 입주 예정] (한국부동산원 청약홈 공고 사본).
 * 조건은 탭 아래 한 줄 칩 → 바텀시트. 지역은 모든 탭, 공급은 일정·결과, 면적·분양가는 결과만.
 */
export function PresalePage() {
  const [tab, setTab] = useState<PresaleTab>("schedule");
  const [metro, setMetro] = useState<PresaleMetro>("all");
  const [supplier, setSupplier] = useState<PresaleSupplier>("all");
  const [area, setArea] = useState<ResultsQuery["area"]>("all");
  const [price, setPrice] = useState<ResultsQuery["price"]>("all");
  const filter = { metro, supplier };
  const pickMetro = (m: string) => {
    setMetro(m);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const filters: FilterDef[] = [
    { key: "metro", title: "지역", options: METRO_OPTIONS, value: metro, defaultId: "all", onChange: setMetro, grid: true },
    ...(tab !== "movein"
      ? [
          {
            key: "supplier",
            title: "공급",
            options: SUPPLIER_OPTIONS,
            value: supplier,
            defaultId: "all",
            onChange: (v: string) => setSupplier(v as PresaleSupplier),
          },
        ]
      : []),
    ...(tab === "results"
      ? [
          {
            key: "area",
            title: "면적",
            options: AREA_OPTIONS,
            value: area,
            defaultId: "all",
            onChange: (v: string) => setArea(v as ResultsQuery["area"]),
          },
          {
            key: "price",
            title: "분양가",
            options: PRICE_OPTIONS,
            value: price,
            defaultId: "all",
            onChange: (v: string) => setPrice(v as ResultsQuery["price"]),
          },
        ]
      : []),
  ];

  const chips = <LabFilterChips filters={filters} ariaLabel="분양 조건" />;

  return (
    <div className={PAGE_SHELL}>
      <PageHeader title="분양 정보" titleClassName="detail-page-title" showDivider={false} titleInHeader />
      {/* 모바일: 탭을 흰 띠로 상단바에 바로 잇는다. 조건 칩은 각 탭 첫 카드 안(목록 바로 위)에 둔다 */}
      <div className="-mx-4 bg-white px-4 sm:mx-0 sm:bg-transparent sm:px-0">
        <LabPageTabs ariaLabel="분양 보기" idPrefix={TAB_PREFIX} items={TABS} value={tab} onChange={setTab} />
      </div>

      <div
        id={labTabPanelId(TAB_PREFIX, tab)}
        role="tabpanel"
        aria-labelledby={labTabId(TAB_PREFIX, tab)}
        className="flex flex-col gap-5 sm:gap-6">
        {tab === "schedule" ? (
          <ApplyhomeUpcomingSection filter={filter} toolbar={chips} />
        ) : tab === "results" ? (
          <>
            <PresaleResults metro={metro} supplier={supplier} area={area} price={price} toolbar={chips} />
            <ApplyhomeCompetitionSection filter={filter} />
          </>
        ) : (
          <MoveInSection metro={metro} onPickMetro={pickMetro} toolbar={chips} />
        )}
      </div>
    </div>
  );
}
