"use client";

import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST, LabListRow, LabTextLink } from "@/components/ui/LabListRow";
import { rankingComplexHref } from "@/lib/region-ranking/public";
import type { RegionBudgetResult } from "@/lib/region/region-budget";
import { formatEok } from "@/lib/utils/format";

const BUDGETS = [
  { id: "100000", label: "10억" },
  { id: "150000", label: "15억" },
  { id: "200000", label: "20억" },
  { id: "250000", label: "25억" },
  { id: "300000", label: "30억" },
] as const;
type BudgetId = (typeof BUDGETS)[number]["id"];

export function RegionBudgetFinderSection({
  lawdCd,
  regionSlug,
  regionName,
}: {
  lawdCd: string;
  regionSlug: string;
  regionName: string;
}) {
  const [budget, setBudget] = useState<BudgetId>("150000");
  const [band, setBand] = useState<string>("30");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["region-budget", lawdCd, budget],
    queryFn: async () => {
      const res = await fetch(`/api/region-budget?lawd_cd=${lawdCd}&budget=${budget}`);
      if (!res.ok) throw new Error("budget");
      return (await res.json()) as RegionBudgetResult;
    },
    staleTime: 10 * 60_000,
    retry: 1,
    placeholderData: (prev) => prev,
  });
  if (query.isError) return null;
  const data = query.data?.status === "ok" ? query.data : null;
  const bands = data?.bands ?? [];
  const current = bands.find((b) => b.key === band) ?? bands[0] ?? null;
  const budgetLabel = BUDGETS.find((b) => b.id === budget)?.label ?? "";
  const listKey = `${budget}|${current?.key ?? ""}`;
  const expanded = expandedKey === listKey;
  const items = current?.items ?? [];
  const visibleItems = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <section
      id="market-budget"
      aria-label={`${regionName} 예산으로 찾기`}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title="예산으로 찾기"
        meta="최근 1년 실거래 기준"
        tip={
          <p>
            최근 1년 매매 실거래의 중간 가격이 예산 이하인 {regionName} 단지를 평형대별로
            보여줍니다. 순서는 집랩 종합 순위를 따릅니다.
          </p>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="detail-label">매매 예산</p>
        <LabTabs
          variant="compact"
          ariaLabel="매매 예산"
          equalWidth={false}
          items={BUDGETS}
          value={budget}
          onChange={setBudget}
        />
      </div>
      {bands.length ? (
        <LabTabs
          variant="secondary"
          ariaLabel="평형대"
          items={bands.map((b) => ({ id: b.key, label: b.label, count: String(b.matched) }))}
          value={current?.key ?? band}
          onChange={setBand}
        />
      ) : null}
      {query.isLoading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : current ? (
        current.items.length === 0 ? (
          <p className="detail-body">
            {budgetLabel} 이하로 거래된 {current.label} 단지가 없습니다.
          </p>
        ) : (
          <>
            <p className="detail-meta tabular-nums">
              {budgetLabel} 이하로 거래된 {current.label} 단지 {current.matched}곳 · 전체{" "}
              {current.total}곳
            </p>
            <ul className={LAB_LIST}>
              {visibleItems.map((item) => (
                <LabListRow
                  key={item.complexId}
                  href={rankingComplexHref({
                    aptName: item.name,
                    regionSlug,
                    gu: regionName,
                    complexId: item.complexId,
                  })}
                  title={item.name ?? "—"}
                  meta={[item.dong, `1년 ${item.tradeCount.toLocaleString("ko-KR")}건`]
                    .filter(Boolean)
                    .join(" · ")}
                  value={formatEok(item.medianDealAmount)}
                />
              ))}
            </ul>
            {items.length > LAB_LIST_PREVIEW ? (
              <LabMoreButton
                expanded={expanded}
                onToggle={() => setExpandedKey(expanded ? null : listKey)}
                label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
              />
            ) : null}
          </>
        )
      ) : null}
      <LabTextLink href="/loan">대출 포함 한도 계산해 보기</LabTextLink>
    </section>
  );
}
