"use client";

import { Activity, ArrowUpRight, CalendarCheck2 } from "lucide-react";
import { LabLoadingDots } from "@/components/ui/LabLoading";
import type { TransactionStats } from "@/types/transaction";

interface StatsCardsProps {
  stats: TransactionStats | undefined;
  isLoading: boolean;
}

export function StatsCards({ stats, isLoading }: StatsCardsProps) {
  // 카드 틀(이름·아이콘·설명)은 먼저 그리고, 숫자 자리만 불러오는 중 표시
  const loading = isLoading || !stats;
  const count = (n: number | undefined) =>
    loading || n == null ? null : `${n.toLocaleString("ko-KR")}건`;

  const miniCards = [
    {
      label: "조회 결과",
      value: count(stats?.totalCount),
      hint: "필터 적용 후 총 거래",
      icon: Activity,
      accent: "bg-teal-50 text-teal-700",
    },
    {
      label: "오늘 등록",
      value: count(stats?.todayCount),
      hint: "당일 계약일자 기준",
      icon: CalendarCheck2,
      accent: "bg-sky-50 text-sky-700",
    },
    {
      label: "최근 7일",
      value: count(stats?.recentCount),
      hint: "단기 거래 동향",
      icon: ArrowUpRight,
      accent: "bg-emerald-50 text-emerald-700",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {miniCards.map((card) => {
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
              {card.value ?? <LabLoadingDots />}
            </p>
            <p className="mt-1 truncate text-xs text-slate-500">{card.hint}</p>
          </article>
        );
      })}
    </div>
  );
}
