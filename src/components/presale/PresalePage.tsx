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
import { LabChoiceChips } from "@/components/ui/LabChoiceChips";
import {
  PresaleMetroTable,
  PresalePriceChart,
  PresaleRateChart,
  PresaleTrendSummary,
  PresaleVolumeChart,
} from "@/components/presale/PresaleTrends";

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
  { id: "stats" as const, label: "분양 동향" },
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
  const filter = { metro, supplier, price, area };

  // 청약 일정 · 분양 결과: 맨 앞에 '무순위'(무순위·잔여세대 공고, 전국)
  const metroChips = (label: string, withRemndr = true) => (
    <LabChoiceChips
      ariaLabel={label}
      options={withRemndr ? [{ id: "remndr", label: "무순위" }, ...METRO_OPTIONS] : METRO_OPTIONS}
      value={!withRemndr && metro === "remndr" ? "all" : metro}
      onChange={setMetro}
    />
  );
  // 지역은 한 줄 선택 칩, 그 아래 줄에 나머지 조건(공급 유형 · 면적 · 분양가) 칩.
  // 분양 동향 탭은 전국 통계라 위 조건 줄이 없다 (입주 예정 카드 안에서만 지역을 고른다).
  const filters: FilterDef[] = [
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
    ...(tab !== "stats"
      ? [
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
    ...(tab !== "stats"
      ? [
          {
            key: "area",
            title: "면적",
            options: AREA_OPTIONS,
            value: area,
            defaultId: "all",
            onChange: (v: string) => setArea(v as ResultsQuery["area"]),
          },
        ]
      : []),
  ];

  const chips = <LabFilterChips filters={filters} ariaLabel="분양 조건" />;

  return (
    <div className={PAGE_SHELL}>
      <PageHeader title="분양 정보" titleClassName="detail-page-title" showDivider={false} titleInHeader />
      {/* 모바일: 탭 + 조건 칩 줄을 흰 띠 하나로 상단바에 잇고, 띠 아래에만 구분선 */}
      <div
        className={`lab-bleed bg-white sm:bg-transparent ${
          tab !== "stats" ? "border-b border-[color:var(--lab-border)] pb-1.5 sm:border-0 sm:pb-0" : ""
        }`}
      >
        <LabPageTabs ariaLabel="분양 보기" idPrefix={TAB_PREFIX} items={TABS} value={tab} onChange={setTab} />
        {tab !== "stats" ? (
          <div className="flex flex-col gap-1 pt-2">
            {metroChips("분양 지역")}
            {chips}
          </div>
        ) : null}
      </div>

      <div
        id={labTabPanelId(TAB_PREFIX, tab)}
        role="tabpanel"
        aria-labelledby={labTabId(TAB_PREFIX, tab)}
        className="flex flex-col gap-3 sm:gap-6">
        {tab === "schedule" ? (
          <ApplyhomeUpcomingSection filter={filter} />
        ) : tab === "results" ? (
          <PresaleResults metro={metro} supplier={supplier} area={area} price={price} />
        ) : (
          <>
            <PresaleTrendSummary />
            <PresaleVolumeChart />
            <PresaleRateChart />
            <PresalePriceChart />
            <PresaleMetroTable />
            {/* 동향 탭은 전국 기준 — 경쟁률 상위도 전국·전체 공급 */}
            <ApplyhomeCompetitionSection filter={{ metro: "all", supplier: "all" }} />
            <MoveInSection
              metro={metro === "remndr" ? "all" : metro}
              onPickMetro={setMetro}
              toolbar={metroChips("입주 예정 지역", false)}
            />
          </>
        )}
      </div>
    </div>
  );
}
