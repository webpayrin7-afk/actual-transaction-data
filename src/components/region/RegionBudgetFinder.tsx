"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  LIST_PREVIEW,
  ListMoreButton,
  MARKET_SECTION_SURFACE,
  MarketSectionHeader,
} from "@/components/region/RegionMarketSections";
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
  const visibleItems = expanded ? items : items.slice(0, LIST_PREVIEW);

  return (
    <section
      id="market-budget"
      aria-label={`${regionName} 예산으로 찾기`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
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
            <ul className="divide-y divide-[color:var(--lab-border)]">
              {visibleItems.map((item) => {
                const href = rankingComplexHref({
                  aptName: item.name,
                  regionSlug,
                  gu: regionName,
                  complexId: item.complexId,
                });
                const body = (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="detail-data-value-emphasis truncate">{item.name ?? "—"}</p>
                      <p className="detail-meta truncate">
                        {[item.dong, `1년 ${item.tradeCount.toLocaleString("ko-KR")}건`]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <p className="detail-data-value-emphasis shrink-0 whitespace-nowrap tabular-nums">
                      {formatEok(item.medianDealAmount)}
                    </p>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  </>
                );
                const cls = "flex min-h-11 items-center gap-3 py-2.5";
                return (
                  <li key={item.complexId}>
                    {href ? (
                      <Link href={href} className={`${cls} hover:bg-slate-50`}>
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {items.length > LIST_PREVIEW ? (
              <ListMoreButton
                expanded={expanded}
                onToggle={() => setExpandedKey(expanded ? null : listKey)}
                label={`${items.length - LIST_PREVIEW}곳 더보기`}
              />
            ) : null}
          </>
        )
      ) : null}
      <Link
        href="/loan"
        className="inline-flex min-h-[44px] items-center gap-0.5 self-start text-[14px] font-semibold leading-5 hover:underline"
        style={{ color: "var(--lab-brand-primary)" }}
      >
        대출 포함 한도 계산해 보기
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
    </section>
  );
}
