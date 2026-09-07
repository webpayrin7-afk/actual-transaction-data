"use client";

import {
  Activity,
  ArrowUpRight,
  Building2,
  CalendarCheck2,
  Crown,
  Layers3,
  MapPinned,
} from "lucide-react";
import {
  formatArea,
  formatDealDate,
  formatEok,
} from "@/lib/utils/format";
import type { Transaction, TransactionStats } from "@/types/transaction";

interface StatsCardsProps {
  stats: TransactionStats | undefined;
  isLoading: boolean;
}

function SkeletonFeatured() {
  return (
    <div className="h-44 animate-pulse rounded-3xl border border-amber-200/60 bg-amber-50/50" />
  );
}

function SkeletonMini() {
  return (
    <div className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white/70" />
  );
}

function MaxDealFeatureCard({ deal }: { deal: Transaction }) {
  return (
    <article className="relative overflow-hidden rounded-3xl border border-amber-300/70 bg-gradient-to-br from-amber-50 via-white to-orange-50 p-5 shadow-md sm:p-6">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(circle at 12% 20%, rgba(245,158,11,0.28), transparent 42%), radial-gradient(circle at 88% 10%, rgba(249,115,22,0.18), transparent 36%)",
        }}
      />

      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white shadow-sm">
              <Crown className="h-3.5 w-3.5" />
              최고가 매매
            </span>
            <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
              이번 조회 구간 1위
            </span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            {deal.aptName}
          </h2>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <MapPinned className="h-4 w-4 text-amber-600" />
              {deal.gu} {deal.dong}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="h-4 w-4 text-amber-600" />
              {formatArea(deal.exclusiveArea)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Layers3 className="h-4 w-4 text-amber-600" />
              {deal.floor}층
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarCheck2 className="h-4 w-4 text-amber-600" />
              {formatDealDate(deal.dealDate)}
            </span>
          </div>
        </div>

        <div className="shrink-0 rounded-2xl border border-amber-200/80 bg-white/90 px-5 py-4 text-right shadow-sm">
          <p className="text-xs font-medium tracking-wide text-amber-700 uppercase">
            거래금액
          </p>
          <p className="mt-1 text-4xl font-semibold tracking-tight text-amber-700 sm:text-5xl">
            {formatEok(deal.dealAmount)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {deal.dealAmount.toLocaleString("ko-KR")}만원
          </p>
        </div>
      </div>
    </article>
  );
}

function EmptyMaxDealCard() {
  return (
    <article className="rounded-3xl border border-dashed border-slate-300 bg-white/80 p-6 text-center">
      <Crown className="mx-auto mb-2 h-6 w-6 text-slate-300" />
      <p className="text-sm font-medium text-slate-700">최고가 매매 없음</p>
      <p className="mt-1 text-xs text-slate-500">
        현재 필터에 매매 거래가 없습니다.
      </p>
    </article>
  );
}

export function StatsCards({ stats, isLoading }: StatsCardsProps) {
  if (isLoading || !stats) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonFeatured />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SkeletonMini />
          <SkeletonMini />
          <SkeletonMini />
        </div>
      </div>
    );
  }

  const miniCards = [
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
  ];

  return (
    <div className="flex flex-col gap-3">
      {stats.maxDeal ? (
        <MaxDealFeatureCard deal={stats.maxDeal} />
      ) : (
        <EmptyMaxDealCard />
      )}

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
                {card.value}
              </p>
              <p className="mt-1 truncate text-xs text-slate-500">{card.hint}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
