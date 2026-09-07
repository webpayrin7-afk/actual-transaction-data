"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Flame,
  Layers3,
  MapPinned,
} from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionDailyDaySummary,
  RegionDailyDeal,
  RegionDailyResponse,
} from "@/lib/molit/service";
import {
  formatArea,
  formatDealDate,
  formatEok,
  toPyeong,
  yearMonthLabel,
} from "@/lib/utils/format";

async function fetchRegionDaily(params: {
  region: string;
  yearMonth: string;
  date?: string;
}): Promise<RegionDailyResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    yearMonth: params.yearMonth,
  });
  if (params.date) qs.set("date", params.date);
  const res = await fetch(`/api/region-daily?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function shiftYearMonth(ym: string, delta: number): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  const date = new Date(year, month - 1 + delta, 1);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function daysInMonth(ym: string): number {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  return new Date(year, month, 0).getDate();
}

function weekdayOfFirst(ym: string): number {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  return new Date(year, month - 1, 1).getDay();
}

function singogaLabel(kind: RegionDailyDeal["singogaKind"]): string {
  if (kind === "type") return "타입신고가";
  if (kind === "pyeong") return "평형신고가";
  return "신고가";
}

function DealCard({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  const pyeong = Math.round(toPyeong(deal.exclusiveArea));
  const contractShort = formatDealDate(deal.dealDate).replace(/^20/, "");

  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="group relative block overflow-hidden rounded-2xl border border-teal-300/70 bg-gradient-to-br from-teal-50 via-white to-cyan-50 p-5 shadow-sm transition hover:border-teal-400"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-700 px-2.5 py-1 text-xs font-semibold text-white">
          <Flame className="h-3.5 w-3.5" />
          {singogaLabel(deal.singogaKind)}
        </span>
        <span className="text-xs text-teal-800/70">
          {formatDealDate(deal.dealDate)}
        </span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xl font-semibold tracking-tight text-slate-900 group-hover:text-teal-900 sm:text-2xl">
            {deal.aptName}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1">
              <MapPinned className="h-3.5 w-3.5 text-teal-600" />
              {deal.gu} {deal.dong}
            </span>
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-3.5 w-3.5 text-teal-600" />
              {formatArea(deal.exclusiveArea)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Layers3 className="h-3.5 w-3.5 text-teal-600" />
              {deal.floor}층
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {deal.exclusiveArea.toFixed(2)}㎡ {pyeong}평 · {deal.floor}층{" "}
            {deal.dealingGbn || "중개거래"} · {contractShort} 계약
          </p>
        </div>

        <div className="shrink-0 text-left sm:text-right">
          <p className="text-xs font-medium tracking-wide text-teal-700 uppercase">
            신고가
          </p>
          <p className="mt-0.5 text-3xl font-semibold tracking-tight text-teal-800 sm:text-4xl">
            {formatEok(deal.dealAmount)}
          </p>
          {deal.increaseAmount > 0 ? (
            <p className="mt-1 text-sm font-semibold text-rose-600">
              ▲ {formatEok(deal.increaseAmount)}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500">
              {deal.dealAmount.toLocaleString("ko-KR")}만원
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1 rounded-xl bg-white/70 px-2.5 py-2">
            <span className="shrink-0 text-[11px] text-slate-500">최고가대비</span>
            <span className="truncate text-sm font-semibold text-slate-800">
              {deal.vsHighPct != null ? `${deal.vsHighPct}%` : "-"}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1 rounded-xl bg-white/70 px-2.5 py-2">
            <span className="shrink-0 text-[11px] text-slate-500">3개월건수</span>
            <span className="truncate text-sm font-semibold text-slate-800">
              {deal.recent3mCount.toLocaleString("ko-KR")}건
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1 rounded-xl bg-white/70 px-2.5 py-2">
            <span className="shrink-0 text-[11px] text-slate-500">타입최고</span>
            <span className="truncate text-sm font-semibold text-slate-800">
              {formatEok(deal.typeMaxAmount)}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1 rounded-xl bg-white/70 px-2.5 py-2">
            <span className="shrink-0 text-[11px] text-slate-500">평형최고</span>
            <span className="truncate text-sm font-semibold text-slate-800">
              {formatEok(deal.pyeongMaxAmount)}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-1 rounded-xl bg-white/70 px-2.5 py-2">
            <span className="shrink-0 text-[11px] text-slate-500">전세가</span>
            <span className="truncate text-sm font-semibold text-slate-800">
              {deal.jeonseAmount != null ? formatEok(deal.jeonseAmount) : "-"}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function MonthCalendar({
  yearMonth,
  days,
  selectedDate,
  onSelectDate,
}: {
  yearMonth: string;
  days: RegionDailyDaySummary[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, RegionDailyDaySummary>();
    for (const day of days) map.set(day.date, day);
    return map;
  }, [days]);

  const totalDays = daysInMonth(yearMonth);
  const offset = weekdayOfFirst(yearMonth);
  const year = yearMonth.slice(0, 4);
  const month = yearMonth.slice(4, 6);
  const cells: Array<number | null> = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weekLabels = ["일", "월", "화", "수", "목", "금", "토"];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="mb-3 grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-slate-400">
        {weekLabels.map((label) => (
          <div key={label}>{label}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, idx) => {
          if (!day) return <div key={`e-${idx}`} className="aspect-square" />;
          const date = `${year}-${month}-${String(day).padStart(2, "0")}`;
          const summary = byDate.get(date);
          const hasDeals = Boolean(summary);
          const active = selectedDate === date;
          return (
            <button
              key={date}
              type="button"
              disabled={!hasDeals}
              onClick={() => onSelectDate(date)}
              className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm transition ${
                active
                  ? "bg-teal-700 text-white shadow-sm"
                  : hasDeals
                    ? "bg-teal-50 text-teal-900 hover:bg-teal-100"
                    : "text-slate-300"
              }`}
            >
              <span className="font-medium">{day}</span>
              {hasDeals && (
                <span
                  className={`mt-0.5 text-[10px] ${
                    active ? "text-teal-100" : "text-teal-600"
                  }`}
                >
                  {summary!.dealCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function RegionDailyStatus({
  regionSlug,
  yearMonth,
  yearMonths,
  onYearMonthChange,
}: {
  regionSlug: string;
  yearMonth: string;
  yearMonths: string[];
  onYearMonthChange: (value: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["region-daily", regionSlug, yearMonth, selectedDate ?? ""],
    queryFn: () =>
      fetchRegionDaily({
        region: regionSlug,
        yearMonth,
        date: selectedDate ?? undefined,
      }),
  });

  const data = query.data;
  const activeDate = selectedDate ?? data?.selectedDate ?? null;

  const canPrev = yearMonths.includes(shiftYearMonth(yearMonth, -1));
  const canNext = yearMonths.includes(shiftYearMonth(yearMonth, 1));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-sm text-slate-600">
          <CalendarDays className="h-4 w-4 text-teal-600" />
          <span>일별 매매 신고가</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => {
              setSelectedDate(null);
              onYearMonthChange(shiftYearMonth(yearMonth, -1));
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            aria-label="이전 달"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <select
            value={yearMonth}
            onChange={(e) => {
              setSelectedDate(null);
              onYearMonthChange(e.target.value);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
          >
            {yearMonths.map((ym) => (
              <option key={ym} value={ym}>
                {yearMonthLabel(ym)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => {
              setSelectedDate(null);
              onYearMonthChange(shiftYearMonth(yearMonth, 1));
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            aria-label="다음 달"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          일별 신고가를 불러오지 못했습니다.
        </p>
      )}

      {(data?.warning || data?.source === "mock") && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data?.warning ?? "데모 데이터로 표시 중입니다."}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {query.isLoading && !data ? (
          <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
        ) : (
          <MonthCalendar
            yearMonth={data?.yearMonth ?? yearMonth}
            days={data?.days ?? []}
            selectedDate={activeDate}
            onSelectDate={setSelectedDate}
          />
        )}

        <div className="flex flex-col gap-3">
          {query.isLoading && !data ? (
            <div className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
          ) : !activeDate || !data?.deals.length ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
              신고가가 있는 날짜를 달력에서 선택해 주세요.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {formatDealDate(activeDate)} 신고가
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    신고가 {data.tradeCount.toLocaleString("ko-KR")}건 · 평균{" "}
                    {formatEok(data.avgDealAmount)}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {data.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    regionSlug={regionSlug}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
