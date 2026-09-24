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

type PresaleTab = "schedule" | "results" | "stats";
const TABS = [
  { id: "schedule" as const, label: "청약 일정" },
  { id: "results" as const, label: "분양 결과" },
  { id: "stats" as const, label: "분양 통계" },
];
const TAB_PREFIX = "presale";

/**
 * 분양 정보 — [청약 일정 | 분양 결과 | 분양 통계] (한국부동산원 청약홈 공고 사본).
 * 조건은 탭 아래 한 줄 칩 → 바텀시트. 지역은 모든 탭, 공급 유형은 일정·결과, 면적·분양가는 결과만.
 * 분양 통계 = 분양·청약·입주를 모아 보는 곳 (최근 경쟁률 높은 곳 · 입주 예정 …).
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
    ...(tab !== "stats"
      ? [
          {
            key: "supplier",
            title: "공급 유형",
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
      {/* 모바일: 탭 + 조건 칩 줄을 흰 띠 하나로 상단바에 잇고, 띠 아래에만 구분선 */}
      <div className="-mx-4 border-b border-[color:var(--lab-border)] bg-white px-4 pb-3.5 sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0">
        <LabPageTabs bare ariaLabel="분양 보기" idPrefix={TAB_PREFIX} items={TABS} value={tab} onChange={setTab} />
        <div className="pt-2">{chips}</div>
      </div>

      <div
        id={labTabPanelId(TAB_PREFIX, tab)}
        role="tabpanel"
        aria-labelledby={labTabId(TAB_PREFIX, tab)}
        className="flex flex-col gap-5 sm:gap-6">
        {tab === "schedule" ? (
          <ApplyhomeUpcomingSection filter={filter} />
        ) : tab === "results" ? (
          <PresaleResults metro={metro} supplier={supplier} area={area} price={price} />
        ) : (
          <>
            {/* 분양 통계 탭엔 공급 유형 칩이 없으니 경쟁률도 전체 공급 기준 */}
            <ApplyhomeCompetitionSection filter={{ metro, supplier: "all" }} />
            <MoveInSection metro={metro} onPickMetro={pickMetro} />
          </>
        )}
      </div>
    </div>
  );
}
