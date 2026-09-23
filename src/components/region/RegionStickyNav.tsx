"use client";

import { LabStickySectionNav } from "@/components/ui/LabStickySectionNav";

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

export function RegionStickyNav({
  anchor,
  title,
  subtitle,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  title: string;
  subtitle?: string;
}) {
  return (
    <LabStickySectionNav
      anchor={anchor}
      sections={MARKET_SECTIONS}
      title={title}
      subtitle={subtitle}
      ariaLabel={`${title} 시장 현황 섹션`}
    />
  );
}
