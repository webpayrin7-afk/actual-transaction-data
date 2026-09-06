"use client";

import {
  Activity,
  ArrowUpRight,
  CalendarCheck2,
  Crown,
} from "lucide-react";
import { formatEok } from "@/lib/utils/format";
import type { TransactionStats } from "@/types/transaction";

interface StatsCardsProps {
  stats: TransactionStats | undefined;
  isLoading: boolean;
}

function SkeletonCard() {
  return (
    <div className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white/70" />
  );
}

export function StatsCards({ stats, isLoading }: StatsCardsProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const cards = [
    {
      label: "조회 결과",
      value: `${stats.totalCount.toLocaleString("ko-KR")}건`,
      hint: "필터 적용 후 총 거래",
      icon: Activity,
      accent: "bg-teal-50 text-teal-700",
    },
    {
      label: "오늘 등록",
      value: `${stats.todayCount.toLocaleString("ko-KR")}건`,
      hint: "당일 계약일자 기준",
      icon: CalendarCheck2,
      accent: "bg-sky-50 text-sky-700",
    },
    {
      label: "최근 7일",
      value: `${stats.recentCount.toLocaleString("ko-KR")}건`,
      hint: "단기 거래 동향",
      icon: ArrowUpRight,
      accent: "bg-emerald-50 text-emerald-700",
    },
    {
      label: "최고가 매매",
      value: stats.maxDeal
        ? formatEok(stats.maxDeal.dealAmount)
        : "-",
      hint: stats.maxDeal
        ? `${stats.maxDeal.aptName} · ${stats.maxDeal.dong}`
        : "매매 데이터 없음",
      icon: Crown,
      accent: "bg-amber-50 text-amber-700",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <article
            key={card.label}
            className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                {card.label}
              </p>
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${card.accent}`}
              >
                <Icon className="h-4 w-4" />
              </span>
            </div>
            <p className="text-2xl font-semibold tracking-tight text-slate-900">
              {card.value}
            </p>
            <p className="mt-1 truncate text-xs text-slate-500">{card.hint}</p>
          </article>
        );
      })}
    </div>
  );
}
