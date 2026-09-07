"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
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

function DealCard({
  deal,
  regionSlug,
  rank,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
  rank: number;
}) {
  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-300 hover:bg-teal-50/40"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-slate-100 px-1.5 text-xs font-semibold text-slate-600">
          {rank}
        </span>
        <span className="rounded-md bg-teal-50 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-teal-700">
          신고가
        </span>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-teal-800">
        {formatEok(deal.dealAmount)}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-400">
        {deal.dealAmount.toLocaleString("ko-KR")}만원
      </p>
      <p className="mt-3 truncate text-sm font-semibold text-slate-900 group-hover:text-teal-900">
        {deal.aptName}
      </p>
      <p className="mt-1 truncate text-xs text-slate-500">
        {deal.gu} {deal.dong} · {formatArea(deal.exclusiveArea)} · {deal.floor}층
      </p>
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
                    매매 {data.tradeCount.toLocaleString("ko-KR")}건 · 평균{" "}
                    {formatEok(data.avgDealAmount)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.deals.map((deal, index) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    regionSlug={regionSlug}
                    rank={index + 1}
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
