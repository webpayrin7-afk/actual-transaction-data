"use client";

import {
  LabStickySectionNav,
  type LabStickySection,
} from "@/components/ui/LabStickySectionNav";

export const MARKET_SECTIONS = [
  { id: "market-price", label: "시세" },
  { id: "market-dong", label: "동네별" },
  { id: "market-jeonse", label: "전세" },
  { id: "market-trends", label: "거래 동향" },
  { id: "newly-seen-deals", label: "신고가" },
  { id: "region-ranking", label: "랭킹" },
  { id: "market-budget", label: "예산" },
  { id: "market-supply", label: "입주" },
  { id: "market-history", label: "거래 내역" },
] as const;

/** 동 상세: 구 시장 현황 섹션을 동 범위로 재사용 + 동 전용 섹션. */
export const DONG_MARKET_SECTIONS = [
  { id: "market-price", label: "시세" },
  { id: "market-compare", label: "주변 동" },
  { id: "market-jeonse", label: "전세" },
  { id: "market-trends", label: "거래 동향" },
  { id: "region-ranking", label: "랭킹" },
  { id: "dong-complexes", label: "단지" },
  { id: "dong-deals", label: "거래 내역" },
] as const;

export function RegionStickyNav({
  anchor,
  title,
  subtitle,
  sections = MARKET_SECTIONS,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  title: string;
  subtitle?: string;
  sections?: readonly LabStickySection[];
}) {
  return (
    <LabStickySectionNav
      anchor={anchor}
      sections={sections}
      title={title}
      subtitle={subtitle}
      ariaLabel={`${title} 시장 현황 섹션`}
    />
  );
}
